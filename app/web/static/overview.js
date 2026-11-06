// Overview page: four panels driven by the ACTIVE ASSET (see app/assets.py).
//
//   every 1 s  GET /api/state    -> latest values, sensor status, recording, asset
//   every 2 s  GET /api/history  -> new points for the graphs (the first load gets the whole time range)
//
// Which sensors each panel shows comes from the asset profile: power/state (plug), probes
// (thermocouples), ambient (room air: every reading of those sensors is shown), thermal
// (default camera), drawing (kettle / generic / photo).

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
  const keys = () => (asset
    ? [...new Set([asset.power, asset.state, ...asset.probes.map(p => p.point), ...envPoints()].filter(Boolean))]
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
    charts.temps = Charts.lineChart($("#ch-temps"),
      asset.probes.map((p, i) => ({ label: p.label, color: probeColor(i), unit: "°C" })));

    $("#temps-legend").innerHTML = asset.probes.length
      ? asset.probes.map((p, i) => `<span class="lg"><i style="background:${probeColor(i)}"></i>${esc(p.label)} <b data-lg="${esc(p.point)}">—</b></span>`).join("")
      : `<span class="dim small">No probes on this asset yet. Use <b>Probes…</b> to add them.</span>`;

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
    charts.temps.setData(Charts.align(hist, asset.probes.map(p => p.point)));
    envPoints().forEach((pid, i) => charts[`spark${i}`]?.setData(Charts.align(hist, [pid])));

    // heating rate of the first probe (the main one)
    const main = asset.probes[0];
    const h = main && hist[main.point];
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
      panelStatus("power", [asset.power, asset.state]);
      panelStatus("probes", asset.probes.map(p => p.point));
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
  img.onload = () => setTimeout(nextFrame, 250);   // next frame only after this one arrived
  img.onerror = () => setTimeout(nextFrame, 1500);
  $("#cam-select").onchange = (e) => { store.set("dt.cam", e.target.value); setCamera(e.target.value); };
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
    if (kind === "power") return { title: "Power & energy", keys: asset.power ? [asset.power] : [], colors: ["#58a6ff"] };
    if (kind === "response") return { title: "Thermal response", keys: asset.probes.map(p => p.point), colors: asset.probes.map((_, i) => probeColor(i)) };
    return { title: "Environment", keys: envPoints(), colors: ENV_COLORS };
  }
  const labelOf = (pid) => (asset.probes.find(p => p.point === pid) || {}).label || (points[pid] || {}).label || pid;
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
      return { label: labelOf(pid), color: cfg.colors[i % cfg.colors.length], unit: u, dp };
    }), { height: 360, legend: true, zero: kind === "power" });
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
    if (detailsKind === "power") rows.push(`<tr><td>Energy over the time shown</td><td colspan="5">${lastEnergyWh == null ? "—" : lastEnergyWh.toFixed(1) + " Wh"}</td></tr>`);
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
