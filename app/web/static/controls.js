// Shared by every page: header (asset picker, Record button, live status, clock), probe editor.
// Pages that poll /api/state themselves (overview.js, app.js) hand the result to window.onState;
// on other pages (runs) this file polls it every 2 s.

const $ = (sel) => document.querySelector(sel);
let lastState = null;

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

// ---------------------------------------------------------------- recording
// Header button: "Record" when idle; a red running timer while recording. Both open #rec-dialog.
let recState = { recording: false };

function showRecView() {
  $("#rec-start-view").hidden = recState.recording;
  $("#rec-live-view").hidden = !recState.recording;
  $("#rec-asset").textContent = lastState && lastState.asset ? lastState.asset.name : "—";
  $("#rec-name").textContent = recState.name || "";
}

$("#rec-btn").onclick = () => {
  showRecView();
  $("#rec-dialog").showModal();
  (recState.recording ? $("#marker-text") : $("#run-name")).focus();
};
for (const b of document.querySelectorAll("#rec-dialog [data-close]")) b.onclick = () => $("#rec-dialog").close();

$("#rec-start").onclick = async () => {
  try {
    await api("POST", "/api/record/start", {
      name: $("#run-name").value, notes: $("#run-notes").value, frames: $("#run-frames").checked,
    });
    $("#run-name").value = "";
    $("#run-notes").value = "";
    $("#rec-dialog").close();
    toast("Recording started");
  } catch (err) { toast(err.message, true); }
};

async function addMarker() {
  try {
    await api("POST", "/api/record/marker", { text: $("#marker-text").value });
    $("#marker-text").value = "";
    toast("Marker added");
  } catch (err) { toast(err.message, true); }
}
$("#marker-btn").onclick = addMarker;
$("#marker-text").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addMarker(); } };

$("#rec-stop").onclick = async () => {
  if (!confirm("Stop this recording?")) return;
  try {
    const meta = await api("POST", "/api/record/stop");
    $("#rec-dialog").close();
    toast(`Saved "${meta.name}": ${meta.rows.toLocaleString()} readings. See Recorded runs.`);
  } catch (err) { toast(err.message, true); }
};

function updateRec(rec) {
  const flipped = rec.recording !== recState.recording;
  recState = rec;
  const btn = $("#rec-btn");
  btn.classList.toggle("on", !!rec.recording);
  btn.title = rec.recording ? "Recording: click to add a marker or stop" : "Start a recording";
  $("#rec-btn-text").textContent = rec.recording ? `REC ${hms(rec.elapsed_s)}` : "Record";
  if (rec.recording) {
    const energy = rec.energy_wh == null ? "" : ` · ${rec.energy_wh.toFixed(1)} Wh`;
    const frames = rec.frames ? ` · ${rec.frames} images` : "";
    const markers = rec.markers ? ` · ${rec.markers} markers` : "";
    $("#rec-stats").textContent = `${hms(rec.elapsed_s)} · ${rec.rows.toLocaleString()} readings${energy}${frames}${markers}`;
  }
  if (flipped && $("#rec-dialog").open) showRecView();
}

// ------------------------------------------------------------- probe editor
function tcPoints(state) {
  // Candidate probes: every temperature point except camera summaries and the asset's room sensors.
  // So a second logger (another TC-08, an ESP probe...) shows up here with no code change.
  const ambient = new Set(state.asset ? state.asset.ambient : []);
  return state.sensors
    .filter(s => s.frames.length === 0)
    .flatMap(s => s.points)
    .filter(p => p.unit === "DEG_C" && !ambient.has(p.point_id) && !p.point_id.endsWith(".cold_junction"));
}

$("#probes-btn").onclick = () => {
  if (!lastState || !lastState.asset) return toast("No asset loaded yet", true);
  const asset = lastState.asset;
  const onAsset = Object.fromEntries(asset.probes.map(p => [p.point, p]));
  const live = Object.fromEntries(tcPoints(lastState).map(p => [p.point_id, p]));
  const ids = [...new Set([...Object.keys(live), ...Object.keys(onAsset)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // The TC-08 can't detect an unplugged probe: an empty socket reads about the logger's own temperature.
  const cj = lastState.sensors.flatMap(s => s.points).find(p => p.point_id.endsWith(".cold_junction"));
  $("#probes-cj").hidden = !cj;
  if (cj) $("#probes-cj").innerHTML = `Logger internal temperature: <b>${Number(cj.value).toFixed(1)} °C</b>. The TC-08 can't detect an unplugged probe:
    an empty socket reads close to this, so "≈ logger" can mean unplugged (or a probe at room temperature). Use the pinch test if unsure.`;
  $("#probes-asset").textContent = asset.name;
  $("#probes-body").innerHTML = ids.length ? ids.map(id => {
    const p = onAsset[id], l = live[id];
    let now = !l ? "not reading" : l.value == null ? "—" : `${Number(l.value).toFixed(1)} °C`;
    if (l && cj && l.value != null && Math.abs(l.value - cj.value) < 0.3) now += " ≈ logger";
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
function updateLiveChip(state) {
  // Green "Live" when every enabled sensor is live; otherwise how many need a look.
  const chip = $("#live-chip");
  const on = state.sensors.filter(s => s.status !== "OFF");
  const bad = on.filter(s => s.status !== "LIVE");
  const worst = bad.some(s => s.status === "ERROR") ? "error" : bad.length ? "stale" : "live";
  chip.className = `live-chip ${worst}`;
  chip.innerHTML = `<span class="dot"></span>${bad.length ? `${bad.length} of ${on.length} need a look` : "Live"}`;
  chip.title = bad.map(s => `${s.label}: ${s.status}`).join("\n") || "All sensors live";
}

window.onState = (state) => {
  lastState = state;
  updateLiveChip(state);
  $("#asset-name").textContent = state.asset ? state.asset.name : "no asset";
  const rec = state.recording || { recording: false };
  updateRec(rec);
  $("#asset-select").disabled = rec.recording;  // the asset is fixed for the length of a run
  $("#probes-btn").disabled = rec.recording;
  if (state.asset && $("#asset-select").dataset.active !== state.asset.id) loadAssets();
};

loadAssets().catch(err => toast(err.message, true));

setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("en-GB"); }, 500);

if (!window.PAGE_POLLS) {
  const poll = async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      $("#banner").hidden = true;
      window.onState(await res.json());
    } catch (e) { $("#banner").hidden = false; }
  };
  poll();
  setInterval(poll, 2000);
}
