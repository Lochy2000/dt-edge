// Lists recorded runs (newest first) with download links. Refreshes every 5 s.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function duration(s) {
  if (s == null) return "—";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
}

async function load() {
  const body = document.getElementById("runs-body");
  try {
    const runs = await (await fetch("/api/runs", { cache: "no-store" })).json();
    if (!runs.length) {
      body.innerHTML = `<tr><td colspan="8" class="dim">No runs yet. Start one from the live dashboard.</td></tr>`;
      return;
    }
    body.innerHTML = runs.map(r => {
      const base = `/api/runs/${encodeURIComponent(r.id)}`;
      const links = r.recording
        ? `<span class="rec-live"><span class="rec-dot"></span> recording…</span>`
        : `<a href="${base}/wide.csv">Excel CSV</a> · <a href="${base}/readings.csv">All readings</a> ·
           <a href="${base}/events.csv">Events</a> · <a href="${base}/download.zip">Zip</a>`;
      return `<tr>
        <td><b>${esc(r.name)}</b><div class="mono dim small">${esc(r.id)}</div></td>
        <td>${esc(r.asset || "—")}</td>
        <td>${new Date(r.started).toLocaleString("en-GB")}</td>
        <td>${r.recording ? "…" : duration(r.duration_s)}</td>
        <td class="mono">${r.rows == null ? "…" : r.rows.toLocaleString()}</td>
        <td class="mono">${r.energy_wh == null ? "—" : r.energy_wh.toFixed(1) + " Wh"}</td>
        <td class="mono">${r.size_mb < 0.1 ? "<0.1" : r.size_mb} MB</td>
        <td>${links}</td></tr>`;
    }).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="err">Couldn't load runs: ${esc(e.message)}</td></tr>`;
  }
}

load();
setInterval(load, 5000);
