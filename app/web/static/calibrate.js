// Calibrate page: compare a box of thermal-camera pixels with a thermocouple at different distances.
// The maths and storage live on the Pi (app/calibration.py); this page only:
//   - shows the live camera image with its real pixels and lets you click to place the box
//   - polls /live twice a second for the numbers
//   - asks the Pi to capture a point (it averages N seconds), and lists the points
// Helpers $, api(), toast(), escHtml() come from controls.js (loaded after this file, so
// everything here starts on DOMContentLoaded).

window.addEventListener("DOMContentLoaded", () => {
  let session = null;          // the selected session (from /api/calibration/sessions/<id>)
  let shape = null;            // camera image [rows, cols]
  let box = null;              // [x, y, w, h] in camera pixels
  let live = null;             // latest /live result
  let capturing = false;

  const img = $("#cal-img"), canvas = $("#cal-overlay"), wrap = $("#cal-imgwrap");
  const fmt = (v, unit = "°C", nd = 1) => (v == null ? "—" : `${v.toFixed(nd)} ${unit}`);
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(0)} %`);
  const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`);

  // ---------------------------------------------------------------- sessions
  async function loadSessions(selectId) {
    const list = await api("GET", "/api/calibration/sessions");
    const sel = $("#cal-session");
    sel.innerHTML = list.length
      ? list.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)} (${s.points} pts)</option>`).join("")
      : `<option value="">No sessions yet</option>`;
    const id = selectId || localStorage.getItem("calSession");
    if (id && list.some(s => s.id === id)) sel.value = id;
    await selectSession(sel.value);
  }

  async function selectSession(id) {
    const oldCam = session?.camera;
    session = id ? await api("GET", `/api/calibration/sessions/${encodeURIComponent(id)}`) : null;
    try { id ? localStorage.setItem("calSession", id) : localStorage.removeItem("calSession"); } catch (e) { /* storage off */ }
    if (session?.camera !== oldCam) { box = null; shape = null; live = null; }
    $("#cal-capture").disabled = !session;
    $("#cal-csv").hidden = $("#cal-del-session").hidden = !session;
    if (session) {
      $("#cal-csv").href = `/api/calibration/sessions/${encodeURIComponent(session.id)}/points.csv`;
      $("#cal-session-info").innerHTML =
        `Camera <b>${escHtml(session.camera)}</b> · reference <b>${escHtml(session.probe_label)}</b> (${escHtml(session.probe)}) · ` +
        `patch <b>${session.patch_mm} mm</b>` + (session.asset_name ? ` · asset ${escHtml(session.asset_name)}` : "") +
        (session.hfov_deg ? "" : ` · <span class="err">no field of view set for this camera, so no patch size in pixels</span>`);
      $("#cal-cam-label").textContent = session.camera;
    } else {
      $("#cal-session-info").textContent = "Start a session: pick the camera, the reference thermocouple and the patch size.";
    }
    renderPoints();
  }

  function renderPoints() {
    const body = $("#cal-points-body");
    if (!session) { body.innerHTML = `<tr><td colspan="14" class="dim">No session selected.</td></tr>`; return; }
    if (!session.points.length) { body.innerHTML = `<tr><td colspan="14" class="dim">No points yet. Set the distance, place the box, then Capture.</td></tr>`; return; }
    body.innerHTML = session.points.map(p => `<tr>
      <td class="mono">${p.n}</td>
      <td class="mono">${p.distance_m.toFixed(2)} m</td>
      <td class="mono">${p.patch_px == null ? "—" : p.patch_px.toFixed(1) + " px"}</td>
      <td class="mono">${fmt(p.probe)} <span class="dim">±${p.probe_std.toFixed(1)}</span></td>
      <td class="mono">${fmt(p.cam_mean)}</td>
      <td class="mono">${fmt(p.cam_max)}</td>
      <td class="mono">${fmt(p.background)}</td>
      <td class="mono">${signed(p.error_mean)}</td>
      <td class="mono">${signed(p.error_max)}</td>
      <td class="mono">${pct(p.loss_mean)}</td>
      <td class="mono">${pct(p.loss_max)}</td>
      <td class="mono">±${p.cam_noise.toFixed(2)}</td>
      <td class="small ${p.warnings.length ? "warn" : "dim"}">${p.warnings.length ? p.warnings.map(escHtml).join("<br>") : "none"}</td>
      <td><button class="btn ghost danger" type="button" data-del="${p.n}">Delete</button></td></tr>`).join("");
  }

  $("#cal-session").addEventListener("change", (e) => selectSession(e.target.value).catch(err => toast(err.message, true)));

  $("#cal-points-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn || !confirm(`Delete point ${btn.dataset.del}?`)) return;
    try {
      session = await api("DELETE", `/api/calibration/sessions/${encodeURIComponent(session.id)}/points/${btn.dataset.del}`);
      renderPoints();
    } catch (err) { toast(err.message, true); }
  });

  $("#cal-del-session").addEventListener("click", async () => {
    if (!session || !confirm(`Delete the whole session "${session.name}" and all ${session.points.length} points? This can't be undone.`)) return;
    try {
      await api("DELETE", `/api/calibration/sessions/${encodeURIComponent(session.id)}`);
      try { localStorage.removeItem("calSession"); } catch (e) { /* storage off */ }
      await loadSessions();
    } catch (err) { toast(err.message, true); }
  });

  // New session dialog: cameras from the Pi, thermocouples from the active asset's probes
  // (falls back to every TC-08 channel if the asset has none ticked).
  $("#cal-new").addEventListener("click", async () => {
    try {
      const [cams, state] = await Promise.all([api("GET", "/api/calibration/cameras"), api("GET", "/api/state")]);
      if (!cams.length) return toast("No camera is sending images yet", true);
      $("#cs-camera").innerHTML = cams.map(c => `<option value="${escHtml(c.point)}">${escHtml(c.label)} (${escHtml(c.point)})</option>`).join("");
      const lep = cams.find(c => c.point.startsWith("lepton"));
      if (lep) $("#cs-camera").value = lep.point;
      let probes = (state.asset?.probes || []).map(p => ({ point: p.point, label: p.label }));
      if (!probes.length) {
        probes = state.sensors.flatMap(s => s.points).filter(p => /^tc08\.ch\d$/.test(p.point_id))
          .map(p => ({ point: p.point_id, label: p.label }));
      }
      $("#cs-probe").innerHTML = probes.map(p => `<option value="${escHtml(p.point)}">${escHtml(p.label)} (${escHtml(p.point)})</option>`).join("");
      $("#cal-dialog").showModal();
    } catch (err) { toast(err.message, true); }
  });

  $("#cs-create").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const s = await api("POST", "/api/calibration/sessions", {
        name: $("#cs-name").value, camera: $("#cs-camera").value, probe: $("#cs-probe").value,
        patch_mm: parseFloat($("#cs-patch").value), notes: $("#cs-notes").value,
      });
      $("#cal-dialog").close();
      box = null;
      await loadSessions(s.id);
      toast("Session created. Set the distance and click the patch.");
    } catch (err) { toast(err.message, true); }
  });

  // ---------------------------------------------------------------- image + box
  // Next frame only after the last one arrived, so a slow network never piles up requests.
  function nextFrame() {
    if (!session) return setTimeout(nextFrame, 500);
    img.src = `/api/frame/${encodeURIComponent(session.camera)}.png?smooth=0&t=${Date.now()}`;
  }
  img.onload = () => { drawOverlay(); setTimeout(nextFrame, 200); };
  img.onerror = () => setTimeout(nextFrame, 1000);
  nextFrame();

  function setBox(cx, cy) {   // centre in camera pixels
    if (!shape) return;
    const n = parseInt($("#cal-box-size").value, 10);
    const x = Math.max(0, Math.min(shape[1] - n, Math.round(cx - (n - 1) / 2)));
    const y = Math.max(0, Math.min(shape[0] - n, Math.round(cy - (n - 1) / 2)));
    box = [x, y, n, n];
    drawOverlay();
    pollLive();
  }

  wrap.addEventListener("click", (e) => {
    if (!shape) return;
    const r = img.getBoundingClientRect();
    setBox(Math.floor((e.clientX - r.left) / r.width * shape[1]), Math.floor((e.clientY - r.top) / r.height * shape[0]));
    wrap.focus();
  });

  wrap.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step || !box) return;
    e.preventDefault();
    setBox(box[0] + (box[2] - 1) / 2 + step[0], box[1] + (box[3] - 1) / 2 + step[1]);
  });

  $("#cal-box-size").addEventListener("change", () => box && setBox(box[0] + (box[2] - 1) / 2, box[1] + (box[3] - 1) / 2));

  // Box (solid), where the patch should be at this distance (dashed), background ring (dotted).
  function drawOverlay() {
    const w = img.clientWidth, h = img.clientHeight;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!box || !shape) return;
    const s = w / shape[1];
    const cx = (box[0] + box[2] / 2) * s, cy = (box[1] + box[3] / 2) * s;
    const patch = live?.patch_px;
    const inner = Math.max(box[2], box[3], patch || 0) / 2 + 0.5;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.setLineDash([2, 3]);       // ring
    ctx.strokeRect(cx - inner * s, cy - inner * s, 2 * inner * s, 2 * inner * s);
    ctx.strokeRect(cx - (inner + 3) * s, cy - (inner + 3) * s, 2 * (inner + 3) * s, 2 * (inner + 3) * s);
    if (patch) {                                                                // expected patch
      ctx.strokeStyle = "#58a6ff"; ctx.setLineDash([5, 4]);
      ctx.strokeRect(cx - patch / 2 * s, cy - patch / 2 * s, patch * s, patch * s);
    }
    ctx.strokeStyle = "#3fd0c9"; ctx.setLineDash([]); ctx.lineWidth = 2;        // box
    ctx.strokeRect(box[0] * s, box[1] * s, box[2] * s, box[3] * s);
  }
  window.addEventListener("resize", drawOverlay);

  // ---------------------------------------------------------------- live numbers
  async function pollLive() {
    if (!session) return;
    const b = box || (shape ? [Math.floor(shape[1] / 2) - 1, Math.floor(shape[0] / 2) - 1, 3, 3] : [0, 0, 1, 1]);
    const d = parseFloat($("#cal-distance").value);
    try {
      live = await api("GET", `/api/calibration/sessions/${encodeURIComponent(session.id)}/live?box=${b.join(",")}` +
        (d > 0 ? `&distance=${d}` : ""));
      shape = live.shape;
      if (!box) { box = live.box; drawOverlay(); }
      $("#lv-probe").textContent = fmt(live.probe);
      $("#lv-mean").textContent = fmt(live.cam_mean);
      $("#lv-max").textContent = fmt(live.cam_max);
      $("#lv-bg").textContent = fmt(live.background);
      $("#lv-err").textContent = live.error_mean == null ? "—" : `${signed(live.error_mean)} / ${signed(live.error_max)} °C`;
      $("#lv-loss").textContent = live.loss_mean == null ? "—" : `${pct(live.loss_mean)} / ${pct(live.loss_max)}`;
      $("#lv-patch").textContent = live.patch_px == null ? (d > 0 ? "unknown FOV" : "enter distance") : `${live.patch_px.toFixed(1)} px wide`;
      $("#lv-amb").textContent = fmt(live.ambient);
      $("#cal-warn").innerHTML = live.warnings.map(w => `<li>${escHtml(w)}</li>`).join("");
    } catch (err) {
      $("#cal-warn").innerHTML = `<li>${escHtml(err.message)}</li>`;
    }
  }
  setInterval(() => { if (!capturing) pollLive(); }, 500);
  $("#cal-distance").addEventListener("input", () => { pollLive().then(drawOverlay); });

  // ---------------------------------------------------------------- capture
  $("#cal-capture").addEventListener("click", async () => {
    const d = parseFloat($("#cal-distance").value);
    if (!(d > 0)) return toast("Enter the distance first", true);
    if (!box) return toast("Click the patch on the image first", true);
    const secs = Math.max(3, Math.min(60, parseInt($("#cal-seconds").value, 10) || 10));
    const btn = $("#cal-capture");
    capturing = true; btn.disabled = true;
    let left = secs;
    btn.textContent = `Capturing… ${left} s`;
    const timer = setInterval(() => { left = Math.max(0, left - 1); btn.textContent = `Capturing… ${left} s`; }, 1000);
    try {
      const p = await api("POST", `/api/calibration/sessions/${encodeURIComponent(session.id)}/capture`,
        { distance_m: d, box, seconds: secs });
      session.points.push(p);
      renderPoints();
      loadSessions(session.id);   // refresh the point count in the dropdown
      toast(`Point ${p.n} at ${p.distance_m} m: error ${signed(p.error_mean)} °C` + (p.warnings.length ? " (see warnings)" : ""), p.warnings.length > 0);
    } catch (err) { toast(err.message, true); }
    clearInterval(timer);
    capturing = false; btn.disabled = false; btn.textContent = "Capture point";
  });

  loadSessions().catch(err => toast(err.message, true));
});
