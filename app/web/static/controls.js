// Asset picker, recording controls and probe editor.
// app.js polls /api/state every second and hands the result to window.onState below.

const $ = (sel) => document.querySelector(sel);
let lastState = null;
let wasRecording = null;  // re-draw the recording bar only when this flips, so typing isn't wiped

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small fetch helper: JSON in, JSON out, server error messages shown to the user.
async function api(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

function hms(s) {
  s = Math.floor(s);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, "0")).join(":");
}

// ------------------------------------------------------------------ assets
async function loadAssets() {
  const { active, assets } = await api("GET", "/api/assets");
  const sel = $("#asset-select");
  sel.innerHTML = assets.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join("")
    + `<option value="__new">+ New asset…</option>`;
  sel.value = active;
  sel.dataset.active = active;
}

$("#asset-select").addEventListener("change", async (e) => {
  const sel = e.target;
  try {
    if (sel.value === "__new") {
      const name = prompt("Name of the new object (e.g. Toaster). It starts as a copy of the current asset.");
      if (!name) { sel.value = sel.dataset.active; return; }
      const created = await api("POST", "/api/assets", { name, copy_from: sel.dataset.active });
      await api("POST", "/api/assets/active", { id: created.id });
      toast(`Created ${created.name}. Use Probes… to name its thermocouples.`);
    } else {
      await api("POST", "/api/assets/active", { id: sel.value });
    }
  } catch (err) {
    toast(err.message, true);
  }
  await loadAssets();
});

// ------------------------------------------------------------- recording bar
function drawRecArea(rec) {
  const area = $("#rec-area");
  if (!rec.recording) {
    area.innerHTML = `
      <input id="run-name" class="grow" placeholder="Run name, e.g. Full kettle: heat-up + cool-down" maxlength="80">
      <input id="run-notes" class="grow" placeholder="Notes (optional)" maxlength="2000">
      <label class="check"><input type="checkbox" id="run-frames" checked> save thermal images</label>
      <button class="btn rec" id="rec-start" type="button"><span class="rec-dot"></span> Start recording</button>`;
    $("#rec-start").onclick = async () => {
      try {
        await api("POST", "/api/record/start", {
          name: $("#run-name").value, notes: $("#run-notes").value, frames: $("#run-frames").checked,
        });
        toast("Recording started");
      } catch (err) { toast(err.message, true); }
    };
  } else {
    area.innerHTML = `
      <span class="rec-live"><span class="rec-dot"></span> REC</span>
      <b class="rec-name">${escHtml(rec.name)}</b>
      <span class="rec-stats" id="rec-stats"></span>
      <input id="marker-text" class="grow" placeholder="Marker, e.g. kettle switched off" maxlength="200">
      <button class="btn ghost" id="marker-btn" type="button">Add marker</button>
      <button class="btn stop" id="rec-stop" type="button">■ Stop</button>`;
    const addMarker = async () => {
      try {
        await api("POST", "/api/record/marker", { text: $("#marker-text").value });
        $("#marker-text").value = "";
        toast("Marker added");
      } catch (err) { toast(err.message, true); }
    };
    $("#marker-btn").onclick = addMarker;
    $("#marker-text").onkeydown = (e) => { if (e.key === "Enter") addMarker(); };
    $("#rec-stop").onclick = async () => {
      if (!confirm("Stop this recording?")) return;
      try {
        const meta = await api("POST", "/api/record/stop");
        toast(`Saved "${meta.name}": ${meta.rows.toLocaleString()} readings. See Recorded runs.`);
      } catch (err) { toast(err.message, true); }
    };
  }
}

function updateRecStats(rec) {
  const el = $("#rec-stats");
  if (!el) return;
  const energy = rec.energy_wh == null ? "" : ` · ${rec.energy_wh.toFixed(1)} Wh`;
  const frames = rec.frames ? ` · ${rec.frames} images` : "";
  el.textContent = `${hms(rec.elapsed_s)} · ${rec.rows.toLocaleString()} readings${energy}${frames}`;
}

// ------------------------------------------------------------- probe editor
function tcPoints(state) {
  // Candidate probes: every temperature point except camera summaries and the asset's room sensors.
  // So a second logger (another TC-08, an ESP probe...) shows up here with no code change.
  const ambient = new Set(state.asset ? state.asset.ambient : []);
  return state.sensors
    .filter(s => s.frames.length === 0)
    .flatMap(s => s.points)
    .filter(p => p.unit === "DEG_C" && !ambient.has(p.point_id));
}

$("#probes-btn").onclick = () => {
  if (!lastState || !lastState.asset) return toast("No asset loaded yet", true);
  const asset = lastState.asset;
  const onAsset = Object.fromEntries(asset.probes.map(p => [p.point, p]));
  const live = Object.fromEntries(tcPoints(lastState).map(p => [p.point_id, p]));
  const ids = [...new Set([...Object.keys(live), ...Object.keys(onAsset)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  $("#probes-asset").textContent = asset.name;
  $("#probes-body").innerHTML = ids.length ? ids.map(id => {
    const p = onAsset[id], l = live[id];
    const now = !l ? "not reading" : l.value == null ? "—" : `${Number(l.value).toFixed(1)} °C`;
    return `<tr data-point="${escHtml(id)}">
      <td><input type="checkbox" class="p-use" ${p ? "checked" : ""}></td>
      <td class="mono">${escHtml(id)}</td>
      <td><input class="p-label" value="${escHtml(p ? p.label : "")}" placeholder="e.g. Water" maxlength="40"></td>
      <td class="mono dim">${escHtml(now)}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="dim">No temperature probes found. Is the TC-08 enabled in sensors.yaml?</td></tr>`;
  $("#probes-dialog").showModal();
};

$("#probes-save").onclick = async (e) => {
  e.preventDefault();
  const asset = lastState.asset;
  const old = Object.fromEntries(asset.probes.map(p => [p.point, p]));
  const rows = [...document.querySelectorAll("#probes-body tr[data-point]")];
  const probes = rows.filter(r => r.querySelector(".p-use").checked).map((r, i) => {
    const point = r.dataset.point;
    const label = r.querySelector(".p-label").value.trim() || point;
    // keep existing dot positions; new probes get a spread-out default (moved on the picture in the next version)
    return old[point] ? { ...old[point], label } : { point, label, x: 20 + (i * 20) % 70, y: 30 + (i * 15) % 60 };
  });
  try {
    await api("PUT", `/api/assets/${encodeURIComponent(asset.id)}`, { ...asset, probes });
    $("#probes-dialog").close();
    toast("Probes saved");
  } catch (err) { toast(err.message, true); }
};

// ------------------------------------------------------------------- wiring
window.onState = (state) => {
  lastState = state;
  const rec = state.recording || { recording: false };
  if (rec.recording !== wasRecording) {
    drawRecArea(rec);
    wasRecording = rec.recording;
  }
  updateRecStats(rec);
  $("#asset-select").disabled = rec.recording;  // the asset is fixed for the length of a run
  $("#probes-btn").disabled = rec.recording;
  if (state.asset && $("#asset-select").dataset.active !== state.asset.id) loadAssets();
};

loadAssets().catch(err => toast(err.message, true));
