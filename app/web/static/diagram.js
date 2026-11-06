// Asset diagram: a simple 2D drawing of the object, with a dot where each probe sits and a
// readable label (name + live value) joined to it by a line.
//
// The SVG is 560 x 340 units and scales to fit its box. Probe positions are stored in % of
// that area (asset.probes[].x / .y), so they survive any screen size. Labels are laid out
// automatically in two columns, left and right of the object, ordered by height so they
// never overlap; each probe's dot, line and label share its graph colour.

const Diagram = (() => {
  const W = 560, H = 340;
  const BOX_W = 128, LEFT_X = 6, RIGHT_X = W - 6 - BOX_W, GAP = 6, MAX_BOX_H = 54;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Built-in drawings (centred, leaving room for the label columns either side)

  // Kettle: the inside runs from y=112 (top) to y=298 (bottom) and widens slightly towards
  // the bottom, so the water's edges follow the walls. level = % full (0-100).
  function kettle(level) {
    const TOP = 112, BOTTOM = 298;
    const y = BOTTOM - (Math.min(Math.max(level, 0), 100) / 100) * (BOTTOM - TOP);
    const left = (yy) => 214 - ((yy - TOP) * 14) / (BOTTOM - TOP) + 2;   // inner wall x at height yy
    const right = (yy) => 346 + ((yy - TOP) * 14) / (BOTTOM - TOP) - 2;
    const water = level > 0
      ? `<path class="dg-water" d="M${left(y)} ${y} L${right(y)} ${y} L${right(BOTTOM - 1)} ${BOTTOM - 1} L${left(BOTTOM - 1)} ${BOTTOM - 1} Z"/>
         <line class="dg-level" x1="${left(y)}" y1="${y}" x2="${right(y)}" y2="${y}"/>
         <text class="dg-caption" x="${right(y) - 6}" y="${y - 6}" text-anchor="end">water ${Math.round(level)}%</text>`
      : `<text class="dg-caption" x="280" y="290" text-anchor="middle">empty</text>`;
    return `${water}
      <g class="dg-line">
        <path d="M200 298 L214 112 Q216 100 228 100 L332 100 Q344 100 346 112 L360 298 Z"/>
        <rect x="222" y="86" width="116" height="14" rx="5"/>
        <rect x="268" y="74" width="24" height="12" rx="4"/>
        <path d="M213 122 L168 99 Q158 94 162 105 L209 158"/>
        <path d="M346 118 C 416 118 416 268 357 268"/>
        <path d="M348 142 C 390 142 390 244 355 244"/>
        <rect x="184" y="300" width="192" height="16" rx="6"/>
      </g>
      <text class="dg-caption" x="280" y="333" text-anchor="middle">base</text>`;
  }

  const GENERIC = `
      <g class="dg-line"><rect x="190" y="60" width="180" height="236" rx="16"/></g>
      <text class="dg-caption" x="280" y="320" text-anchor="middle">object under test</text>`;

  // opts.waterLevel: % full, for the kettle drawing
  function drawing(g, kind, imageUrl, opts = {}) {
    if (kind === "photo" && imageUrl) {
      g.innerHTML = `<image href="${esc(imageUrl)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet"/>`;
    } else if (kind === "kettle") {
      g.innerHTML = kettle(opts.waterLevel ?? 60);
    } else {
      g.innerHTML = GENERIC;
    }
  }

  // items: [{i, label, value, color, x, y}] -> adds cx, cy (dot) and bx, by, bh, side (label box)
  function layout(items) {
    const placed = items.map(it => ({ ...it, cx: (it.x / 100) * W, cy: (it.y / 100) * H }));
    for (const side of ["L", "R"]) {
      const col = placed.filter(p => (p.cx < W / 2) === (side === "L")).sort((a, b) => a.cy - b.cy);
      if (!col.length) continue;
      const bh = Math.min(MAX_BOX_H, (H - 8 - GAP * (col.length - 1)) / col.length); // shrink when crowded
      let next = 4;
      for (const p of col) {           // top to bottom, each label as close to its dot as possible
        p.side = side;
        p.bh = bh;
        p.bx = side === "L" ? LEFT_X : RIGHT_X;
        p.by = Math.max(next, p.cy - bh / 2);
        next = p.by + bh + GAP;
      }
      let limit = H - 4;               // then push back up anything that ran off the bottom
      for (let k = col.length - 1; k >= 0; k--) {
        col[k].by = Math.min(col[k].by, limit - bh);
        limit = col[k].by - GAP;
      }
    }
    return placed;
  }

  function overlay(g, items, editing) {
    g.innerHTML = layout(items).map(p => {
      const s = p.bh / MAX_BOX_H;                                // text scales with the box
      const ax = p.side === "L" ? p.bx + BOX_W : p.bx;           // where the line meets the box
      const ay = p.by + p.bh / 2;
      const elbow = p.side === "L" ? ax + 12 : ax - 12;
      const name = p.label.length > 15 ? p.label.slice(0, 14) + "…" : p.label;
      return `<g class="probe" data-i="${p.i}">
        <polyline class="leader" points="${p.cx},${p.cy} ${elbow},${ay} ${ax},${ay}" stroke="${p.color}"/>
        <rect class="lbox" x="${p.bx}" y="${p.by}" width="${BOX_W}" height="${p.bh}" rx="6"/>
        <rect x="${p.bx}" y="${p.by}" width="4" height="${p.bh}" rx="2" fill="${p.color}"/>
        <text class="lname" x="${p.bx + 11}" y="${p.by + 19 * s}" font-size="${14 * s}">${esc(name)}</text>
        <text class="lval" x="${p.bx + 11}" y="${p.by + 44 * s}" font-size="${22 * s}">${esc(p.value)}</text>
        <circle class="hit" cx="${p.cx}" cy="${p.cy}" r="16"/>
        <circle class="dot" cx="${p.cx}" cy="${p.cy}" r="${editing ? 9 : 7}" fill="${p.color}"/>
      </g>`;
    }).join("");
  }

  // pointer position -> % of the drawing area (for dragging dots)
  function toPct(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const clamp = (v) => Math.min(Math.max(v, 0), 100);
    return { x: clamp((p.x / W) * 100), y: clamp((p.y / H) * 100) };
  }

  return { drawing, overlay, toPct };
})();
