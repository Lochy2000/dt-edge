// Chart helpers around uPlot (a small, fast time-series library: https://github.com/leeoniya/uPlot).
// Every chart on the overview is made with lineChart() so they share one look.
//
// uPlot wants data as columns: [ [x times...], [series 1 values...], [series 2 values...] ]
// with the SAME x for every series. Our sensors report at different moments, so align()
// merges their timestamps and fills the holes with null.

const Charts = (() => {
  const css = getComputedStyle(document.documentElement);
  const C = (name) => css.getPropertyValue(name).trim();

  // One colour per probe, in order. The probe dots on the asset picture use the same colours.
  const PALETTE = ["#f0883e", "#e3b341", "#39c5bb", "#a371f7", "#58a6ff", "#db61a2", "#7ee787", "#ff7b72"];

  function align(hist, keys) {
    const times = new Set();
    for (const k of keys) for (const t of (hist[k]?.t || [])) times.add(t);
    const xs = [...times].sort((a, b) => a - b);
    const at = new Map(xs.map((t, i) => [t, i]));
    const ys = keys.map(k => {
      const col = new Array(xs.length).fill(null);
      const h = hist[k];
      if (h) h.t.forEach((t, i) => { col[at.get(t)] = h.v[i]; });
      return col;
    });
    return [xs, ...ys];
  }

  // Time labels in 24-hour UK style; seconds shown when zoomed in to 10 minutes or less.
  function timeLabels(u, splits) {
    const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
    const o = span <= 600 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    return splits.map(t => new Date(t * 1000).toLocaleTimeString("en-GB", o));
  }

  // series: [{label, color, unit, dp, fill}]   opts: {height, spark, legend, zero}
  //   zero: y axis always starts at 0 (power, energy), so noise isn't magnified into spikes
  function lineChart(el, series, opts = {}) {
    const spark = !!opts.spark;
    const axis = {
      stroke: C("--dim"),
      grid: { stroke: C("--line"), width: 1 },
      ticks: { stroke: C("--line"), width: 1 },
      font: "11px " + C("--sans"),
    };
    const u = new uPlot({
      width: Math.max(el.clientWidth, 100),
      height: opts.height || 160,
      padding: spark ? [4, 0, 4, 0] : [10, 12, 0, 0],
      legend: { show: !!opts.legend, live: true },
      cursor: spark ? { show: false } : { drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: { time: true },
        y: opts.zero ? { range: (u, lo, hi) => [0, hi > 0 ? hi * 1.1 : 1] } : {},
      },
      axes: spark ? [{ show: false }, { show: false }] : [
        { ...axis, values: timeLabels },
        { ...axis, size: 48, values: (u, vals) => vals.map(v => (Math.abs(v) >= 1000 ? v.toLocaleString() : +v.toFixed(2))) },
      ],
      series: [
        { value: (u, t) => (t == null ? "—" : new Date(t * 1000).toLocaleTimeString("en-GB")) },
        ...series.map(s => ({
          label: s.label,
          stroke: s.color,
          width: spark ? 1.5 : 2,
          fill: s.fill ? s.color + "22" : undefined,
          spanGaps: true,            // sensors that report every 2 s still draw a continuous line
          points: { show: false },
          value: (u, v) => (v == null ? "—" : `${v.toFixed(s.dp ?? 1)} ${s.unit || ""}`),
        })),
      ],
    }, [[], ...series.map(() => [])], el);

    // keep the chart as wide as its box
    new ResizeObserver(() => u.setSize({ width: Math.max(el.clientWidth, 100), height: u.height })).observe(el);
    return u;
  }

  // Energy (Wh) as the area under the power curve, from the first point shown. Gaps > 30 s aren't bridged.
  function cumulativeWh(t, w) {
    const out = new Array(t.length).fill(null);
    let e = 0, prev = -1;
    for (let i = 0; i < t.length; i++) {
      if (w[i] == null) continue;
      if (prev >= 0) {
        const dt = t[i] - t[prev];
        if (dt > 0 && dt < 30) e += ((w[i] + w[prev]) / 2) * dt / 3600;
      }
      out[i] = e;
      prev = i;
    }
    return out;
  }

  // Least-squares slope of the last `windowS` seconds, in units per minute (e.g. degC/min).
  function ratePerMin(t, v, windowS = 60) {
    if (!t.length) return null;
    const tEnd = t[t.length - 1];
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = t.length - 1; i >= 0 && t[i] >= tEnd - windowS; i--) {
      if (v[i] == null) continue;
      const x = t[i] - tEnd;
      n++; sx += x; sy += v[i]; sxx += x * x; sxy += x * v[i];
    }
    if (n < 10) return null; // too few points to trust
    const d = n * sxx - sx * sx;
    return d ? ((n * sxy - sx * sy) / d) * 60 : null;
  }

  return { PALETTE, align, lineChart, cumulativeWh, ratePerMin };
})();
