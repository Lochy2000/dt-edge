// Sensors page: polls /api/state once a second and builds one card per sensor automatically.
// A new sensor in sensors.yaml appears here with no front-end changes.
window.PAGE_POLLS = true; // tells controls.js this page fetches the state itself

const STATUS_COLOUR = {
  LIVE: "var(--live)", STALE: "var(--stale)", ERROR: "var(--error)",
  WAITING: "var(--waiting)", OFF: "var(--off)",
};
const STATUS_ORDER = ["LIVE", "WAITING", "STALE", "ERROR", "OFF"];

// QUDT unit id -> [display text, decimal places]
const UNITS = {
  DEG_C: ["°C", 1], PERCENT_RH: ["%RH", 0], HectoPA: ["hPa", 0],
  W: ["W", 1], "KiloW-HR": ["kWh", 3],
};

const grid = document.getElementById("grid");
const cards = {}; // sensor id -> { el, parts }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatValue(p) {
  if (p.value === null || p.value === undefined) return "—";
  if (typeof p.value === "boolean") return p.value ? "ON" : "OFF";
  if (typeof p.value !== "number") return esc(p.value);
  const [unit, dp] = UNITS[p.unit] || [p.unit || "", 1];
  return `${p.value.toFixed(dp)}<small>${esc(unit)}</small>`;
}

function makeCard(sensor) {
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="card-head">
      <div><h2></h2><span class="type"></span></div>
      <span class="pill"></span>
    </div>
    <div class="frames"></div>
    <div class="metrics"></div>
    <div class="card-foot"></div>`;
  grid.appendChild(el);
  return {
    el,
    title: el.querySelector("h2"),
    type: el.querySelector(".type"),
    pill: el.querySelector(".pill"),
    frames: el.querySelector(".frames"),
    metrics: el.querySelector(".metrics"),
    foot: el.querySelector(".card-foot"),
    frameViews: {},
  };
}

// One <img> per thermal image, refreshed continuously (next request only after the last one loaded).
function makeFrameView(container, pointId) {
  const wrap = document.createElement("div");
  wrap.className = "frame-wrap";
  wrap.innerHTML = `
    <div class="frame"><img alt="thermal image"></div>
    <div class="scale"><span class="hi">--</span><div class="bar"></div><span class="lo">--</span></div>`;
  container.appendChild(wrap);
  const img = wrap.querySelector("img");
  const next = () => { img.src = `/api/frame/${encodeURIComponent(pointId)}.png?t=${Date.now()}`; };
  img.onload = () => setTimeout(next, 250);
  img.onerror = () => setTimeout(next, 1500);
  next();
  return { hi: wrap.querySelector(".hi"), lo: wrap.querySelector(".lo") };
}

// Thermocouple sockets not ticked in Probes... for the current asset are shown dimmed ("not in use"):
// the TC-08 still reports a number for an empty socket, so this is the only way to tell them apart.
let inUse = null; // Set of point ids on the active asset

function updateCard(c, s) {
  c.el.style.setProperty("--c", STATUS_COLOUR[s.status]);
  c.el.classList.toggle("wide", s.frames.length > 0);
  c.title.textContent = s.label;
  c.type.textContent = `${s.type} · ${s.id}`;
  c.pill.textContent = s.status;

  for (const f of s.frames) {
    const v = c.frameViews[f.point_id] || (c.frameViews[f.point_id] = makeFrameView(c.frames, f.point_id));
    v.hi.textContent = f.hi.toFixed(1);
    v.lo.textContent = f.lo.toFixed(1);
  }

  if (s.points.length) {
    c.metrics.innerHTML = s.points.map(p => {
      const unused = s.type === "tc08" && inUse && !inUse.has(p.point_id) && !p.point_id.endsWith(".cold_junction");
      return `
      <div class="metric ${p.quality === "BAD" ? "bad" : ""} ${unused ? "unused" : ""}" title="${esc(p.point_id)}${unused ? " · not ticked in Probes…" : ""}">
        <span class="m-label">${esc(p.label)}${unused ? " · not in use" : ""}</span>
        <span class="m-value">${formatValue(p)}</span>
      </div>`;
    }).join("");
  } else {
    c.metrics.innerHTML = `<div class="no-data">${s.status === "OFF" ? "Disabled in sensors.yaml" : "No data yet"}</div>`;
  }

  if (s.error && s.status === "ERROR") {
    c.foot.innerHTML = `<span class="err">${esc(s.error)}</span>`;
  } else if (s.age_s !== null) {
    c.foot.textContent = `updated ${s.age_s.toFixed(1)} s ago`;
  } else {
    c.foot.textContent = s.status === "OFF" ? "off" : "waiting for first reading…";
  }
}

function updateSummary(counts) {
  document.getElementById("summary").innerHTML = STATUS_ORDER
    .filter(k => counts[k])
    .map(k => `<span class="chip" style="--c:${STATUS_COLOUR[k]}"><span class="dot"></span><b>${counts[k]}</b> ${k.toLowerCase()}</span>`)
    .join("");
}

async function tick() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    document.getElementById("banner").hidden = true;
    inUse = state.asset ? new Set(state.asset.probes.map(p => p.point)) : null;
    for (const s of state.sensors) {
      const c = cards[s.id] || (cards[s.id] = makeCard(s));
      updateCard(c, s);
    }
    updateSummary(state.counts);
    // recording bar etc. (controls.js); its own errors must not show the "lost connection" banner
    if (window.onState) { try { window.onState(state); } catch (err) { console.error(err); } }
  } catch (e) {
    document.getElementById("banner").hidden = false;
  }
}

setInterval(tick, 1000);
tick();
