// Overview page: four panels driven by the ACTIVE ASSET (see app/assets.py).
//
//   every 1 s  GET /api/state    -> latest values, sensor status, recording, asset
//   every 2 s  GET /api/history  -> new points for the graphs (the first load gets the whole time range)
//
// Which sensors each panel shows comes from the asset profile: panel (top left: "power" = the
// smart plug's power/state, "compare" = every camera's max/mean or min vs room air), probes
// (thermocouples), spots (fixed points on a thermal image, shown dashed next to the probes),
// ambient (room air: every reading of those sensors is shown), thermal (default camera),
// camera_scale (fixed colour range per camera), drawing (kettle / matrix / generic / photo).

window.PAGE_POLLS = true; // tells controls.js this page fetches the state itself

(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {  // per-viewer preferences; browser storage can be unavailable, so never rely on it
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // QUDT unit id -> [display text, decimal places]
  const UNITS = { DEG_C: ["°C", 1], PERCENT_RH: ["%RH", 0], HectoPA: ["hPa", 0], W: ["W", 0], "KiloW-HR": ["kWh", 3] };
  function fmt(v, unit, html = true) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "boolean") return v ? "ON" : "OFF";
    const [u, dp] = UNITS[unit] || [unit || "", 1];
    const num = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(v).toFixed(dp);
    return html ? `${num}<small>${esc(u)}</small>` : `${num} ${u}`;
  }
  function fmtWh(wh) {
    if (wh == null) return "—";
    return wh >= 1000 ? `${(wh / 1000).toFixed(2)}<small>kWh</small>` : `${wh.toFixed(1)}<small>Wh</small>`;
  }
  const ENV_COLORS = ["#58a6ff", "#3fb950", "#e3b341", "#a371f7"];
  const CAM_COLORS = ["#f0883e", "#58a6ff", "#db61a2"];   // camera comparison: one colour per camera
  const ROOM_COLOR = "#3fb950";

  // ------------------------------------------------------------------ state
  let state = null;         // latest /api/state
  let asset = null;         // active asset profile
  let assetSig = "";        // to notice when the asset (or its probes) changes
  let envSig = "";          // ...or the set of room-air readings
  let points = {};          // point_id -> latest message
  let sensors = {};         // sensor id -> sensor view (status, frames, ...)
  let rangeMin = Number(store.get("dt.range")) || 30;
  const hist = {};          // point_id -> {t: [...], v: [...]}  (epoch seconds, values)
  let lastT = 0;            // newest timestamp received
  let charts = {};          // uPlot instances
  let lastEnergyWh = null;
  let draft = null;         // probe positions while "Move probes" is on
  let dragIndex = null;
  let camId = null;         // frame point shown, e.g. "lepton.image"
  let detailsKind = null, detailsChart = null;
  let cmpView = store.get("dt.cmp") === "min" ? "min" : "max";  // camera comparison: "max" (max & mean) or "min" (min vs room)
  let cmpSig = "";          // to notice when the compared series change

  const sensorOf = (pid) => sensors[String(pid).split(".")[0]];
  const probeColor = (i) => Charts.PALETTE[i % Charts.PALETTE.length];

  // Room air: every reading of the sensors named in asset.ambient (so pressure etc. appear too)
  function envPoints() {
    if (!asset) return [];
    const ids = [...new Set(asset.ambient.map(p => p.split(".")[0]))];
    const out = [];
    for (const id of ids) {
      const s = sensors[id];
      if (s && s.points.length) out.push(...s.points.filter(p => typeof p.value !== "boolean").map(p => p.point_id));
      else out.push(...asset.ambient.filter(p => p.startsWith(id + ".")));
    }
    return out;
  }
  // Camera spots (asset.spots): point id <camera>.spot<id>, e.g. lepton.spot1
  const spotList = () => (asset ? asset.spots || [] : []);
  const spotPid = (s) => `${s.camera}.spot${s.id}`;
  // Thermal response graph: the probes (solid), then the camera spots (dashed)
  function tempSeries() {
    if (!asset) return [];
    return [
      ...asset.probes.map((p, i) => ({ pid: p.point, label: p.label, color: probeColor(i) })),
      ...spotList().map((s, j) => ({ pid: spotPid(s), label: `${s.label} (camera)`, color: probeColor(asset.probes.length + j), dash: [6, 4] })),
    ];
  }

  // Camera comparison (asset.panel == "compare")
  const isCompare = () => !!(asset && asset.panel === "compare");
  const camSensors = () => (state ? state.sensors.filter(s => s.status !== "OFF" && (s.frames.length || s.type === "lepton" || s.type === "mlx90640")) : []);
  const shortName = (s) => (String(s.label).split("·").pop() || s.label).trim();
  function compareSeries() {
    if (!isCompare()) return [];
    const out = [];
    camSensors().forEach((s, i) => {
      const color = CAM_COLORS[i % CAM_COLORS.length];
      if (cmpView === "max") {
        out.push({ pid: `${s.id}.max`, label: `${shortName(s)} max`, color });
        out.push({ pid: `${s.id}.mean`, label: `${shortName(s)} mean`, color, dash: [6, 4] });
      } else {
        out.push({ pid: `${s.id}.min`, label: `${shortName(s)} min`, color });
      }
    });
    if (cmpView === "min" && asset.ambient[0]) out.push({ pid: asset.ambient[0], label: "Room air", color: ROOM_COLOR });
    return out;
  }

  const keys = () => (asset
    ? [...new Set([asset.power, asset.state, ...tempSeries().map(t => t.pid), ...compareSeries().map(c => c.pid), ...envPoints()].filter(Boolean))]
    : []);

  // --------------------------------------------------------------- polling
  async function tickState() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state = await res.json();
      $("#banner").hidden = true;
    } catch (e) {
      $("#banner").hidden = false;
      return;
    }
    points = {};
    sensors = {};
    for (const s of state.sensors) {
      sensors[s.id] = s;
      for (const p of s.points) points[p.point_id] = p;
    }
    try { window.onState(state); } catch (err) { console.error(err); } // header (controls.js)
    const sig = JSON.stringify(state.asset);
    if (sig !== assetSig) {
      assetSig = sig;
      asset = state.asset;
      onAssetChanged();
    }
    const es = envPoints().join(",");
    if (es !== envSig) { envSig = es; buildEnvTiles(); loadHistory(true); }
    renderLive();
  }

  async function loadHistory(full) {
    if (!asset) return;
    const ks = keys();
    if (!ks.length) return;
    const q = `points=${encodeURIComponent(ks.join(","))}`;
    // live updates re-ask for the newest second too, because that bucket can still change
    const url = full ? `/api/history?${q}&minutes=${rangeMin}` : `/api/history?${q}&since=${lastT - 1}`;
    let data;
    try { data = await (await fetch(url, { cache: "no-store" })).json(); } catch { return; }
    for (const [pid, s] of Object.entries(data)) {
      if (full || !hist[pid]) hist[pid] = { t: [], v: [] };
      const h = hist[pid];
      s.t.forEach((t, i) => {
        const n = h.t.length;
        if (n && h.t[n - 1] === t) h.v[n - 1] = s.v[i];
        else if (!n || t > h.t[n - 1]) { h.t.push(t); h.v.push(s.v[i]); }
        if (t > lastT) lastT = t;
      });
    }
    const cutoff = Date.now() / 1000 - rangeMin * 60;
    for (const h of Object.values(hist)) {
      let i = 0;
      while (i < h.t.length && h.t[i] < cutoff) i++;
      if (i) { h.t.splice(0, i); h.v.splice(0, i); }
    }
    redrawCharts();
  }

  // ------------------------------------------------------- asset changed
  function onAssetChanged() {
    for (const u of Object.values(charts)) u.destroy();
    charts = {};
    for (const k of Object.keys(hist)) delete hist[k];
    lastT = 0;
    envSig = "";
    if (!asset) return;

    charts.power = Charts.lineChart($("#ch-power"), [{ label: "Power", color: "#58a6ff", unit: "W", dp: 0, fill: true }], { zero: true, noXAxis: true });
    charts.energy = Charts.lineChart($("#ch-energy"), [{ label: "Energy", color: "#a371f7", unit: "Wh", dp: 1 }], { zero: true });
    const ts = tempSeries();
    charts.temps = Charts.lineChart($("#ch-temps"), ts.map(t => ({ label: t.label, color: t.color, unit: "°C", dash: t.dash })));

    $("#temps-legend").innerHTML = ts.length
      ? ts.map(t => `<span class="lg"><i class="${t.dash ? "dash" : ""}" style="background:${t.color};color:${t.color}"></i>${esc(t.label)} <b data-lg="${esc(t.pid)}">—</b></span>`).join("")
      : `<span class="dim small">No probes on this asset yet. Use <b>Probes…</b> to add thermocouples, or <b>Spots</b> on the thermal image.</span>`;

    $("#p-power").classList.toggle("mode-compare", isCompare());
    cmpSig = "";
    ensureCompareChart();
    endSpotEdit(false);
    pick = null;

    syncWaterControl();
    const sel = $("#drawing-select");
    sel.value = asset.drawing || "generic";
    sel.querySelector('option[value="photo"]').disabled = !asset.image;
    if (!draft) renderDrawing();
  }

  // room-air tiles, one per reading, each with a sparkline
  function buildEnvTiles() {
    for (const k of Object.keys(charts)) if (k.startsWith("spark")) { charts[k].destroy(); delete charts[k]; }
    const env = envPoints();
    $("#env-tiles").innerHTML = env.map((pid, i) => `
      <div class="tile env-tile">
        <span class="t-label" data-elabel="${esc(pid)}">${esc((points[pid] || {}).label || pid)}</span>
        <b class="t-value" data-eval="${esc(pid)}">—</b>
        <div class="spark" id="spark-${i}"></div>
      </div>`).join("") || `<div class="dim small">No room sensors set for this asset.</div>`;
    env.forEach((pid, i) => {
      charts[`spark${i}`] = Charts.lineChart($(`#spark-${i}`), [{ label: pid, color: ENV_COLORS[i % ENV_COLORS.length] }], { spark: true });
    });
  }

  // Camera comparison chart: rebuilt when the compared series change (view toggle, a camera turned on)
  function ensureCompareChart() {
    if (!isCompare()) return;
    const cs = compareSeries();
    const sig = `${cmpView}|${cs.map(c => c.pid).join(",")}`;
    if (sig === cmpSig) return;
    cmpSig = sig;
    if (charts.compare) charts.compare.destroy();
    $("#ch-compare").innerHTML = "";
    charts.compare = Charts.lineChart($("#ch-compare"), cs.map(c => ({ label: c.label, color: c.color, unit: "°C", dash: c.dash })));
    $("#cmp-legend").innerHTML = cs.length
      ? cs.map(c => `<span class="lg"><i class="${c.dash ? "dash" : ""}" style="background:${c.color};color:${c.color}"></i>${esc(c.label)} <b data-lg="${esc(c.pid)}">—</b></span>`).join("")
      : `<span class="dim small">No thermal cameras enabled in sensors.yaml.</span>`;
    for (const b of document.querySelectorAll("#cmp-view [data-cmp]")) b.classList.toggle("on", b.dataset.cmp === cmpView);
    loadHistory(true);
  }
  for (const b of document.querySelectorAll("#cmp-view [data-cmp]")) {
    b.onclick = () => { cmpView = b.dataset.cmp; store.set("dt.cmp", cmpView); ensureCompareChart(); renderLive(); };
  }

  // tiles above the comparison graph: the gap between the first two cameras (or camera vs room)
  function renderCompareTiles() {
    const cams = camSensors();
    const val = (pid) => { const p = points[pid]; return p && typeof p.value === "number" ? p.value : null; };
    const diff = (a, b) => (a == null || b == null ? "—" : `${a - b >= 0 ? "+" : ""}${(a - b).toFixed(1)}<small>°C</small>`);
    let tiles = [];
    if (cmpView === "max") {
      if (cams.length >= 2) {
        const [a, b] = cams;
        tiles = [[`Max gap · ${shortName(a)} − ${shortName(b)}`, diff(val(`${a.id}.max`), val(`${b.id}.max`))],
                 [`Mean gap · ${shortName(a)} − ${shortName(b)}`, diff(val(`${a.id}.mean`), val(`${b.id}.mean`))]];
      } else if (cams.length === 1) {
        const a = cams[0];
        tiles = [[`${shortName(a)} max`, val(`${a.id}.max`) == null ? "—" : fmt(val(`${a.id}.max`), "DEG_C")],
                 [`${shortName(a)} mean`, val(`${a.id}.mean`) == null ? "—" : fmt(val(`${a.id}.mean`), "DEG_C")]];
      }
    } else {
      const room = asset.ambient[0] ? val(asset.ambient[0]) : null;
      tiles = cams.slice(0, 2).map(c => [`${shortName(c)} min − room air`, diff(val(`${c.id}.min`), room)]);
    }
    $("#cmp-tiles").innerHTML = tiles.map(([l, v]) => `<div class="tile"><span class="t-label">${esc(l)}</span><b class="t-value">${v}</b></div>`).join("");
  }

  // ------------------------------------------------------------- charts
  function redrawCharts() {
    if (!asset || !charts.power) return;
    if (asset.power) {
      const [xs, w] = Charts.align(hist, [asset.power]);
      charts.power.setData([xs, w]);
      const e = Charts.cumulativeWh(xs, w);
      charts.energy.setData([xs, e]);
      lastEnergyWh = e.length ? e[e.length - 1] : null;
    }
    charts.temps.setData(Charts.align(hist, tempSeries().map(t => t.pid)));
    if (charts.compare) charts.compare.setData(Charts.align(hist, compareSeries().map(c => c.pid)));
    envPoints().forEach((pid, i) => charts[`spark${i}`]?.setData(Charts.align(hist, [pid])));

    // heating rate of the first probe (the main one), or the first camera spot if there are no probes
    const main = tempSeries()[0];
    const h = main && hist[main.pid];
    const rate = h ? Charts.ratePerMin(h.t, h.v) : null;
    $("#rate-label").textContent = main ? `${rate != null && rate < 0 ? "Cooling" : "Heating"} rate · ${main.label}` : "Heating rate";
    $("#rate-now").innerHTML = rate == null ? "—" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}<small>°C/min</small>`;

    if (detailsKind) updateDetails();
  }

  // -------------------------------------------------------- live values
  function panelStatus(kind, pids) {
    const el = document.querySelector(`.pstat[data-for="${kind}"]`);
    const ss = [...new Set(pids.filter(Boolean).map(sensorOf).filter(Boolean))];
    const bad = ss.filter(s => s.status !== "LIVE");
    el.textContent = bad.map(s => `${s.label}: ${s.status}`).join(" · ");
    el.className = `pstat ${bad.some(s => s.status === "ERROR") ? "error" : bad.length ? "stale" : ""}`;
  }

  function renderLive() {
    if (!state) return;
    const rec = state.recording || {};
    if (asset) {
      const pw = points[asset.power], st = points[asset.state];
      $("#power-now").innerHTML = pw ? fmt(pw.value, pw.unit) : "—";
      const stEl = $("#state-now");
      stEl.textContent = `PLUG ${st ? fmt(st.value) : "—"}`;
      stEl.classList.toggle("on", !!(st && st.value === true));
      if (rec.recording && rec.energy_wh != null) {
        $("#energy-label").textContent = "Energy this run";
        $("#energy-now").innerHTML = fmtWh(rec.energy_wh);
      } else {
        $("#energy-label").textContent = `Energy, last ${rangeMin} min`;
        $("#energy-now").innerHTML = fmtWh(lastEnergyWh);
      }
      if (isCompare()) {
        ensureCompareChart();
        renderCompareTiles();
        panelStatus("power", compareSeries().map(c => c.pid));
      } else {
        panelStatus("power", [asset.power, asset.state]);
      }
      panelStatus("probes", tempSeries().map(t => t.pid));
      // fan matrix drawing: the fans turn while a recording runs
      svg.classList.toggle("spin", !!(rec.recording && asset.drawing === "matrix"));
      panelStatus("ambient", envPoints());

      for (const el of document.querySelectorAll("[data-lg]")) {
        const p = points[el.dataset.lg];
        el.textContent = p ? fmt(p.value, p.unit, false) : "—";
      }
      for (const el of document.querySelectorAll("[data-eval]")) {
        const p = points[el.dataset.eval];
        el.innerHTML = p ? fmt(p.value, p.unit) : "—";
      }
      for (const el of document.querySelectorAll("[data-elabel]")) {
        const p = points[el.dataset.elabel];
        if (p) el.textContent = p.label;
      }
      if (dragIndex === null) renderOverlay();
      syncWaterControl();
    }
    renderCamera();
  }

  // ------------------------------------------------------- thermal camera
  function renderCamera() {
    const cams = state.sensors.filter(s => s.frames.length || s.type === "lepton" || s.type === "mlx90640");
    const sel = $("#cam-select");
    const ids = cams.map(s => (s.frames[0] ? s.frames[0].point_id : `${s.id}.image`));
    if (sel.dataset.ids !== ids.join(",")) {
      sel.innerHTML = cams.map((s, i) => `<option value="${esc(ids[i])}">${esc(s.label)}</option>`).join("")
        || `<option value="">No camera</option>`;
      sel.dataset.ids = ids.join(",");
      const pref = store.get("dt.cam");
      const pick = [pref, asset && asset.thermal].find(id => id && ids.includes(id)) || ids[0] || null;
      sel.value = pick || "";
      setCamera(pick);
    }
    const sensor = camId ? sensorOf(camId) : null;
    const f = sensor && sensor.frames.find(x => x.point_id === camId);
    $("#cam-hi").textContent = f ? f.hi.toFixed(1) : "--";
    $("#cam-lo").textContent = f ? f.lo.toFixed(1) : "--";
    for (const m of ["min", "mean", "max"]) {
      const p = sensor && points[`${sensor.id}.${m}`];
      $(`#cam-${m}`).innerHTML = p ? fmt(p.value, p.unit) : "—";
    }
    updateRangeBtn();
    if (!spotDraft) renderSpots();
    if (pick) updatePick();
    const msg = $("#cam-msg");
    msg.hidden = !!(sensor && sensor.status === "LIVE");
    msg.textContent = !sensor ? "No camera connected" : sensor.status === "ERROR" ? (sensor.error || "Camera error") : sensor.status;
    panelStatus("camera", camId ? [camId] : []);
  }

  function setCamera(id) {
    const first = camId === null;
    camId = id;
    if (first && id) nextFrame();
  }
  const img = $("#cam-img");
  function nextFrame() {
    if (!camId) { setTimeout(nextFrame, 1000); return; }
    img.src = `/api/frame/${encodeURIComponent(camId)}.png?t=${Date.now()}`;
  }
  img.onload = () => { placeOverlay(); setTimeout(nextFrame, 250); };   // next frame only after this one arrived
  img.onerror = () => setTimeout(nextFrame, 1500);
  $("#cam-select").onchange = (e) => {
    store.set("dt.cam", e.target.value);
    endSpotEdit(false);
    pick = null;
    setCamera(e.target.value);
    renderSpots();
  };

  // ---------------------------------- thermal image overlay: click readout + camera spots
  // The overlay is placed exactly over the picture (the image is letterboxed in full screen), so
  // positions are simply % of the overlay = % of the image, whatever the camera's resolution.
  const overlay = $("#cam-overlay");
  const frameEl = overlay.parentElement;
  let pick = null;          // click readout: {x, y, value} (% of the image)
  let spotDraft = null;     // the shown camera's spots while "Spots" editing is on
  let spotDrag = null, spotMoved = false, downOnSpot = false;
  let spotSel = null, skipClick = false, dragFrom = null;   // selected spot (index in spotDraft) while editing
  const camSensorId = () => (camId ? camId.split(".")[0] : null);
  const clampPct = (v) => Math.min(Math.max(v, 0), 100);
  const pctOf = (e) => {
    const r = overlay.getBoundingClientRect();
    return { x: clampPct(((e.clientX - r.left) / r.width) * 100), y: clampPct(((e.clientY - r.top) / r.height) * 100) };
  };

  function placeOverlay() {
    const nw = img.naturalWidth, nh = img.naturalHeight, fw = frameEl.clientWidth, fh = frameEl.clientHeight;
    if (!nw || !nh || !fw || !fh) { overlay.style.display = "none"; return; }
    const k = Math.min(fw / nw, fh / nh), w = nw * k, h = nh * k;
    Object.assign(overlay.style, { display: "", left: `${(fw - w) / 2}px`, top: `${(fh - h) / 2}px`, width: `${w}px`, height: `${h}px` });
  }

  function renderSpots() {
    placeOverlay();
    const cam = camSensorId();
    const list = spotDraft || spotList().filter(s => s.camera === cam);
    const html = list.map((s, i) => {
      const p = points[spotPid(s)];
      const val = spotDraft ? "" : (p ? fmt(p.value, p.unit, false) : "—");
      const del = spotDraft ? `<button type="button" data-del="${i}" title="Delete this spot">✕</button>` : "";   // editing: ✕ above every spot
      return `<div class="spot${s.x > 62 ? " left" : ""}${spotDraft && i === spotSel ? " sel" : ""}" data-i="${i}" style="left:${s.x}%;top:${s.y}%"><i></i><span><b>${esc(s.label)}</b>${esc(val)}</span>${del}</div>`;
    });
    if (pick && !spotDraft) {
      const v = pick.value == null ? "…" : `${pick.value.toFixed(1)} °C`;
      html.push(`<div class="spot pick${pick.x > 62 ? " left" : ""}" style="left:${pick.x}%;top:${pick.y}%"><i></i><span>${esc(v)}</span><button type="button" data-unpick title="Remove">✕</button></div>`);
    }
    overlay.innerHTML = html.join("");
  }

  // click readout: asks the Pi for the temperature under the point (3 x 3 pixel mean on the Lepton), every second
  async function updatePick() {
    if (!pick || !camId) return;
    const want = pick;
    try {
      const r = await api("GET", `/api/frame/${encodeURIComponent(camId)}/at?x=${want.x.toFixed(2)}&y=${want.y.toFixed(2)}`);
      if (pick === want) pick.value = r.value;
    } catch { if (pick === want) pick.value = null; }
    if (!spotDraft) renderSpots();
  }

  // Editing spots. Everything is decided on pointerdown (and from our own flags), never from the
  // target of a later click/double-click: while a dot is dragged the overlay captures the pointer,
  // so the browser sends those events to the overlay, not the dot (why double-click never worked).
  const nameBox = $("#spot-name");
  function selectSpot(i) {                 // the selected spot's name is edited in the bar under the image
    spotSel = i;
    const s = i === null ? null : spotDraft[i];
    $("#spot-hint").hidden = !!s;
    nameBox.hidden = !s;
    $("#spot-del").hidden = !s;
    if (s) nameBox.value = s.label;
  }
  function deleteSpot(i) {
    spotDraft.splice(i, 1);
    spotDrag = null;
    selectSpot(null);
    renderSpots();
  }
  nameBox.oninput = () => {
    if (!spotDraft || spotSel === null) return;
    spotDraft[spotSel].label = nameBox.value.slice(0, 40);
    renderSpots();
  };
  nameBox.onkeydown = (e) => { if (e.key === "Enter") nameBox.blur(); };
  $("#spot-del").onclick = () => { if (spotDraft && spotSel !== null) deleteSpot(spotSel); };

  overlay.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button");
    if (btn) {                             // a ✕: act now, and ignore the click that follows
      skipClick = true;
      if (btn.dataset.del !== undefined && spotDraft) deleteSpot(Number(btn.dataset.del));
      else { pick = null; renderSpots(); }
      return;
    }
    skipClick = false;
    downOnSpot = !!e.target.closest(".spot");
    if (!spotDraft || !downOnSpot) return;
    e.preventDefault();
    spotDrag = Number(e.target.closest(".spot").dataset.i);
    spotMoved = false;
    dragFrom = { x: e.clientX, y: e.clientY };
    selectSpot(spotDrag);
    renderSpots();
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (spotDrag === null) return;
    if (!spotMoved && Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) < 4) return;   // a shaky click is not a drag
    Object.assign(spotDraft[spotDrag], pctOf(e));
    spotMoved = true;
    renderSpots();
  });
  const endSpotDrag = () => { spotDrag = null; };
  overlay.addEventListener("pointerup", endSpotDrag);
  overlay.addEventListener("pointercancel", endSpotDrag);

  overlay.addEventListener("click", (e) => {
    if (skipClick) { skipClick = false; return; }
    const onSpot = downOnSpot;
    downOnSpot = false;
    if (spotDraft) {
      if (spotMoved) { spotMoved = false; return; }                       // end of a drag
      if (onSpot) { nameBox.focus(); nameBox.select(); return; }          // click on a spot = rename it
      const cam = camSensorId();                                          // click on empty image = new spot
      if (spotList().filter(s => s.camera !== cam).length + spotDraft.length >= 8) return toast("Up to 8 spots per asset", true);
      const used = new Set(spotDraft.map(s => s.id));
      const id = [1, 2, 3, 4, 5, 6, 7, 8].find(n => !used.has(n));
      spotDraft.push({ id, camera: cam, label: `Spot ${id}`, ...pctOf(e) });
      selectSpot(spotDraft.length - 1);
      renderSpots();
      return;
    }
    if (onSpot) return;                    // clicking a saved spot or the readout does nothing
    pick = { ...pctOf(e), value: null };
    renderSpots();
    updatePick();
  });

  $("#spots-btn").onclick = () => {
    if (!asset || !camId) return toast("No camera to put spots on", true);
    if (state.recording && state.recording.recording) return toast("Can't change spots during a recording", true);
    if (spotDraft) return;
    spotDraft = spotList().filter(s => s.camera === camSensorId()).map(s => ({ ...s }));
    pick = null;
    selectSpot(null);
    overlay.classList.add("editing");
    $("#spot-bar").hidden = false;
    renderSpots();
  };
  function endSpotEdit(redraw = true) {
    spotDraft = null;
    spotDrag = null;
    spotSel = null;
    overlay.classList.remove("editing");
    $("#spot-bar").hidden = true;
    if (redraw) renderSpots();
  }
  $("#spots-cancel").onclick = () => endSpotEdit();
  $("#spots-save").onclick = async () => {
    const cam = camSensorId();
    const mine = spotDraft.map(s => ({ ...s, label: s.label.trim() || `Spot ${s.id}`, x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 }));
    const spots = [...spotList().filter(s => s.camera !== cam), ...mine];
    try {
      await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, spots });
      endSpotEdit();
      toast(mine.length ? `Spots saved: shown in Thermal response and recorded as ${cam}.spot1, ${cam}.spot2…` : "Spots removed");
    } catch (err) { toast(err.message, true); }
  };
  window.addEventListener("resize", placeOverlay);
  document.addEventListener("fullscreenchange", () => setTimeout(placeOverlay, 50));

  // ---------------------------------------------- colour range of the image (per asset and camera)
  const camScale = () => { const sid = camSensorId(); return asset && sid ? (asset.camera_scale || {})[sid] : undefined; };
  function updateRangeBtn() {
    const sc = camScale();
    $("#range-btn").textContent = Array.isArray(sc) ? `Range ${sc[0]}–${sc[1]} °C` : "Range: auto";
  }
  const rangeMode = () => (document.querySelector('input[name="rmode"]:checked') || {}).value;
  function syncRangeInputs() { const fixed = rangeMode() === "fixed"; $("#range-lo").disabled = !fixed; $("#range-hi").disabled = !fixed; }
  for (const r of document.querySelectorAll('input[name="rmode"]')) r.onchange = syncRangeInputs;
  $("#range-btn").onclick = () => {
    if (!asset || !camId) return toast("No camera", true);
    const sensor = sensorOf(camId);
    const sc = camScale();
    const mn = sensor && points[`${sensor.id}.min`], mx = sensor && points[`${sensor.id}.max`];
    const lo = Array.isArray(sc) ? sc[0] : (mn ? Math.floor(mn.value) : 0);
    const hi = Array.isArray(sc) ? sc[1] : (mx ? Math.ceil(mx.value) : 35);
    $("#range-cam").textContent = sensor ? sensor.label : camId;
    document.querySelector(`input[name="rmode"][value="${Array.isArray(sc) ? "fixed" : "auto"}"]`).checked = true;
    $("#range-lo").value = lo;
    $("#range-hi").value = hi;
    $("#range-now").innerHTML = mn && mx
      ? `Image right now: min <b>${Number(mn.value).toFixed(1)} °C</b>, max <b>${Number(mx.value).toFixed(1)} °C</b>. Anything outside a fixed range shows as the end colour.`
      : "No image from this camera yet.";
    syncRangeInputs();
    $("#range-dialog").showModal();
  };
  $("#range-save").onclick = async (e) => {
    e.preventDefault();
    const sid = camSensorId();
    let value = "auto";
    if (rangeMode() === "fixed") {
      const lo = parseFloat($("#range-lo").value), hi = parseFloat($("#range-hi").value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return toast("Min must be a number below max", true);
      value = [lo, hi];
    }
    try {
      await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, camera_scale: { ...(asset.camera_scale || {}), [sid]: value } });
      $("#range-dialog").close();
      toast(value === "auto" ? "Colour range: auto" : `Colour range fixed at ${value[0]}–${value[1]} °C`);
    } catch (err) { toast(err.message, true); }
  };
  $("#cam-full").onclick = () => { const el = $("#thermal-box"); (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); };

  // ------------------------------------------------ asset drawing + probe dots
  const svg = $("#diagram");

  function renderDrawing(level) {
    const url = asset && asset.image ? `/api/assets/${encodeURIComponent(asset.id)}/image?v=${Date.now()}` : null;
    const waterLevel = level ?? (asset ? asset.water_level : 60);
    Diagram.drawing($("#dg-drawing"), asset ? asset.drawing : "generic", url, { waterLevel });
    renderOverlay();
  }

  // Water level slider (kettle drawing only): moves the water live, saves when you let go.
  const waterRange = $("#water-range");
  function syncWaterControl() {
    const isKettle = asset && asset.drawing === "kettle";
    $("#water-ctl").hidden = !isKettle;
    if (!isKettle) return;
    const level = asset.water_level ?? 60;
    if (document.activeElement !== waterRange) waterRange.value = level;
    $("#water-val").textContent = `${Math.round(waterRange.value)}%`;
    waterRange.disabled = !!(state && state.recording && state.recording.recording);
  }
  waterRange.oninput = () => {
    $("#water-val").textContent = `${waterRange.value}%`;
    Diagram.drawing($("#dg-drawing"), "kettle", null, { waterLevel: Number(waterRange.value) });
  };
  waterRange.onchange = async () => {
    try {
      await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, water_level: Number(waterRange.value) });
    } catch (err) { toast(err.message, true); waterRange.value = asset.water_level; renderDrawing(); }
  };

  function renderOverlay() {
    if (!asset) return;
    const probes = draft || asset.probes;
    Diagram.overlay($("#dg-overlay"), probes.map((p, i) => {
      const live = points[p.point];
      return {
        i, label: p.label, x: p.x, y: p.y, color: probeColor(i),
        value: live ? fmt(live.value, live.unit, false) : "no reading",
      };
    }), !!draft);
  }

  // drag a dot while "Move probes" is on (the pointer is captured by the whole drawing,
  // so re-drawing the dots on every move doesn't drop the drag)
  svg.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".probe");
    if (!draft || !g) return;
    e.preventDefault();
    dragIndex = Number(g.dataset.i);
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (dragIndex === null) return;
    Object.assign(draft[dragIndex], Diagram.toPct(svg, e.clientX, e.clientY));
    renderOverlay();
  });
  const endDrag = () => { dragIndex = null; };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  function setEditing(on) {
    draft = on ? asset.probes.map(p => ({ ...p })) : null;
    svg.classList.toggle("editing", on);
    $("#move-btn").hidden = on;
    $("#move-save").hidden = !on;
    $("#move-cancel").hidden = !on;
    renderOverlay();
  }
  $("#move-btn").onclick = () => {
    if (!asset || !asset.probes.length) return toast("Add probes first with Probes…", true);
    if (state.recording && state.recording.recording) return toast("Can't move probes during a recording", true);
    setEditing(true);
  };
  $("#move-cancel").onclick = () => setEditing(false);
  $("#move-save").onclick = async () => {
    const probes = draft.map(p => ({ ...p, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    try {
      await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, probes });
      setEditing(false);
      toast("Probe positions saved");
    } catch (err) { toast(err.message, true); }
  };

  $("#drawing-select").onchange = async (e) => {
    if (e.target.value === "__upload") {   // "Upload new photo…": pick a file, keep the current drawing until it's uploaded
      e.target.value = asset.drawing;
      $("#img-input").click();
      return;
    }
    try {
      await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, drawing: e.target.value });
    } catch (err) { toast(err.message, true); e.target.value = asset.drawing; }
  };

  $("#img-input").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !asset) return;
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/image`, { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "upload failed");
      toast("Photo uploaded. Use Move probes to place the dots; switch back to the drawing any time.");
    } catch (err) { toast(err.message, true); }
  };

  // ---------------------------------------------------------- details dialog
  function detailsConfig(kind) {
    if (kind === "power" && isCompare()) {
      const cs = compareSeries();
      return { title: "Camera comparison", keys: cs.map(c => c.pid), colors: cs.map(c => c.color), dashes: cs.map(c => c.dash) };
    }
    if (kind === "power") return { title: "Power & energy", keys: asset.power ? [asset.power] : [], colors: ["#58a6ff"] };
    if (kind === "response") {
      const ts = tempSeries();
      return { title: "Thermal response", keys: ts.map(t => t.pid), colors: ts.map(t => t.color), dashes: ts.map(t => t.dash) };
    }
    return { title: "Environment", keys: envPoints(), colors: ENV_COLORS };
  }
  const labelOf = (pid) => (asset.probes.find(p => p.point === pid) || {}).label
    || ((tempSeries().concat(compareSeries())).find(t => t.pid === pid) || {}).label || (points[pid] || {}).label || pid;
  const unitOf = (pid) => (points[pid] || {}).unit;

  function openDetails(kind) {
    if (!asset) return;
    detailsKind = kind;
    const cfg = detailsConfig(kind);
    $("#details-title").textContent = cfg.title;
    $("#details-dialog").showModal();
    if (detailsChart) detailsChart.destroy();
    $("#details-chart").innerHTML = "";
    detailsChart = Charts.lineChart($("#details-chart"), cfg.keys.map((pid, i) => {
      const [u, dp] = UNITS[unitOf(pid)] || ["", 1];
      return { label: labelOf(pid), color: cfg.colors[i % cfg.colors.length], unit: u, dp, dash: (cfg.dashes || [])[i] };
    }), { height: 360, legend: true, zero: kind === "power" && !isCompare() });
    updateDetails();
  }

  function updateDetails() {
    const cfg = detailsConfig(detailsKind);
    const data = Charts.align(hist, cfg.keys);
    detailsChart.setData(data);
    $("#details-range").textContent = `last ${rangeMin} min · ${data[0].length} points`;
    const rows = cfg.keys.map((pid, i) => {
      const vals = data[i + 1].filter(v => v != null);
      const unit = unitOf(pid);
      const stat = (f) => (vals.length ? fmt(f(vals), unit, false) : "—");
      return `<tr><td><i class="sw" style="background:${cfg.colors[i % cfg.colors.length]}"></i>${esc(labelOf(pid))}</td>
        <td>${points[pid] ? fmt(points[pid].value, unit, false) : "—"}</td>
        <td>${stat(a => Math.min(...a))}</td><td>${stat(a => Math.max(...a))}</td>
        <td>${stat(a => a.reduce((s, v) => s + v, 0) / a.length)}</td><td class="mono dim">${esc(pid)}</td></tr>`;
    });
    if (detailsKind === "power" && !isCompare()) rows.push(`<tr><td>Energy over the time shown</td><td colspan="5">${lastEnergyWh == null ? "—" : lastEnergyWh.toFixed(1) + " Wh"}</td></tr>`);
    $("#details-stats").innerHTML = rows.join("") || `<tr><td colspan="6" class="dim">No sensors set for this panel.</td></tr>`;
  }

  $("#details-close").onclick = () => $("#details-dialog").close();
  $("#details-dialog").addEventListener("close", () => { detailsKind = null; });
  $("#details-csv").onclick = () => {
    const cfg = detailsConfig(detailsKind);
    const [xs, ...cols] = Charts.align(hist, cfg.keys);
    const head = ["time", ...cfg.keys.map(pid => `${labelOf(pid)} (${(UNITS[unitOf(pid)] || [unitOf(pid) || ""])[0]}) [${pid}]`)];
    const lines = [head, ...xs.map((t, i) => [new Date(t * 1000).toISOString(), ...cols.map(c => c[i] ?? "")])];
    const csv = lines.map(r => r.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${asset.id}_${detailsKind}_last${rangeMin}min.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  for (const b of document.querySelectorAll("[data-details]")) b.onclick = () => openDetails(b.dataset.details);

  // ---------------------------------------------------------------- start
  const rangeSel = $("#range-select");
  rangeSel.value = String(rangeMin);
  rangeSel.onchange = () => { rangeMin = Number(rangeSel.value); store.set("dt.range", rangeMin); loadHistory(true); };

  let builtAtRem = Charts.rem();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(Charts.rem() - builtAtRem) / builtAtRem > 0.08 && asset) {
        builtAtRem = Charts.rem();
        assetSig = ""; // next tick rebuilds the charts at the new text size
      }
    }, 300);
  });

  tickState();
  setInterval(tickState, 1000);
  setInterval(() => loadHistory(false), 2000);
})();
