"use strict";

// Two small SVG chart forms, built for this site's dark panels. No library.
//
//   Chart.line(container, { points, color, yLabel, format, baseline })
//   Chart.recordBar(container, { wins, draws, losses })
//
// Palette note: the hues are the dark-mode categorical steps, validated against
// the #333 panel surface (lightness band, chroma floor, normal-vision
// separation and 3:1 contrast all pass). The win/loss pair sits in the 6–8 CVD
// separation band, which is only legal with a second channel — so the record bar
// direct-labels every segment and leaves a 2px surface gap between them. Never
// remove those labels.

window.Chart = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const COLORS = { blue: "#3987e5", green: "#199e70", red: "#e66767", violet: "#9085e9" };
  // Ink, never the series colour — text carries no identity here.
  const INK = "#d8d8d8";
  const MUTED = "#8c8c8c";
  const GRID = "#4a4a4a";

  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // More points than pixels is wasted work and a muddier line; keep the shape.
  function downsample(points, max) {
    if (points.length <= max) return points;
    const step = (points.length - 1) / (max - 1);
    const out = [];
    for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
    return out;
  }

  function niceBounds(values, baseline) {
    let lo = Math.min.apply(null, values);
    let hi = Math.max.apply(null, values);
    if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
    if (lo === hi) { lo -= 1; hi += 1; }          // a flat series still needs a band
    const pad = (hi - lo) * 0.12;
    return { lo: lo - pad, hi: hi + pad };
  }

  // A line chart of one series. One series means no legend: the panel heading
  // names it.
  function line(container, opts) {
    const raw = (opts.points || []).filter((p) => p && isFinite(p.value));
    container.innerHTML = "";
    if (raw.length < 2) {
      const p = document.createElement("p");
      p.className = "chart-empty";
      p.textContent = opts.empty || "Not enough data yet.";
      container.appendChild(p);
      return;
    }

    const points = downsample(raw, 160);
    const color = opts.color || COLORS.blue;
    const fmt = opts.format || ((v) => String(Math.round(v)));
    const W = 560, H = 190;
    const PAD = { l: 44, r: 12, t: 12, b: 26 };
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const { lo, hi } = niceBounds(points.map((p) => p.value), opts.baseline);
    const x = (i) => PAD.l + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v) => PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, class: "chart-svg",
      role: "img", "aria-label": opts.ariaLabel || opts.yLabel || "chart",
    });

    // Recessive grid: three horizontal rules with their values, nothing else.
    for (const frac of [0, 0.5, 1]) {
      const v = lo + (hi - lo) * frac;
      const yy = y(v);
      svg.appendChild(el("line", { x1: PAD.l, x2: W - PAD.r, y1: yy, y2: yy, stroke: GRID, "stroke-width": 1 }));
      const t = el("text", { x: PAD.l - 6, y: yy + 4, "text-anchor": "end", fill: MUTED, "font-size": 11 });
      t.textContent = fmt(v);
      svg.appendChild(t);
    }

    // The zero line on a chart that can go negative is the reference the reader
    // measures against, so it is drawn heavier than the grid.
    if (opts.baseline != null && opts.baseline > lo && opts.baseline < hi) {
      const yb = y(opts.baseline);
      svg.appendChild(el("line", {
        x1: PAD.l, x2: W - PAD.r, y1: yb, y2: yb, stroke: MUTED, "stroke-width": 1, "stroke-dasharray": "3 3",
      }));
    }

    const d = points.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1)).join(" ");
    svg.appendChild(el("path", {
      d, fill: "none", stroke: color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));

    // End marker: where the reader's eye lands, and the only labelled point.
    const last = points.length - 1;
    svg.appendChild(el("circle", { cx: x(last), cy: y(points[last].value), r: 4, fill: color }));

    // Date range along the bottom, first and last only — a label per point is
    // noise at this width.
    const firstT = el("text", { x: PAD.l, y: H - 8, fill: MUTED, "font-size": 11 });
    firstT.textContent = shortDate(points[0].at);
    const lastT = el("text", { x: W - PAD.r, y: H - 8, "text-anchor": "end", fill: MUTED, "font-size": 11 });
    lastT.textContent = shortDate(points[last].at);
    svg.append(firstT, lastT);

    // --- hover layer: crosshair + tooltip ---
    const cross = el("line", {
      x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + plotH, stroke: INK, "stroke-width": 1, opacity: 0,
    });
    const dot = el("circle", { r: 4, fill: color, stroke: "#222", "stroke-width": 2, opacity: 0 });
    svg.append(cross, dot);
    container.appendChild(svg);

    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.style.display = "none";
    container.appendChild(tip);

    // A generous hit target: the whole plot, mapped to the nearest point.
    const hit = el("rect", { x: PAD.l, y: PAD.t, width: plotW, height: plotH, fill: "transparent" });
    svg.appendChild(hit);

    function onMove(e) {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      let best = 0;
      for (let i = 1; i < points.length; i++) {
        if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
      }
      const p = points[best];
      cross.setAttribute("x1", x(best));
      cross.setAttribute("x2", x(best));
      cross.setAttribute("opacity", 0.35);
      dot.setAttribute("cx", x(best));
      dot.setAttribute("cy", y(p.value));
      dot.setAttribute("opacity", 1);
      tip.textContent = fmt(p.value) + (p.at ? " · " + shortDate(p.at) : "");
      tip.style.display = "";
      const left = (x(best) / W) * box.width;
      tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + "px";
      tip.style.top = ((y(p.value) / H) * box.height - tip.offsetHeight - 8) + "px";
    }
    function onLeave() {
      cross.setAttribute("opacity", 0);
      dot.setAttribute("opacity", 0);
      tip.style.display = "none";
    }
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerleave", onLeave);
  }

  // Part-to-whole: one thin stacked bar for a win/draw/loss record. Every
  // segment is directly labelled — green and red are the classic CVD collision,
  // and this palette's pair sits in the band where a second channel is required.
  function recordBar(container, rec) {
    container.innerHTML = "";
    const total = rec.wins + rec.draws + rec.losses;
    if (!total) {
      const p = document.createElement("p");
      p.className = "chart-empty";
      p.textContent = "No finished games yet.";
      container.appendChild(p);
      return;
    }
    const bar = document.createElement("div");
    bar.className = "record-bar";
    const seg = (n, cls, colour) => {
      if (!n) return;
      const d = document.createElement("div");
      d.className = "record-seg " + cls;
      d.style.flexGrow = String(n);
      d.style.background = colour;
      d.title = n + " " + cls;
      bar.appendChild(d);
    };
    seg(rec.wins, "wins", COLORS.green);
    seg(rec.draws, "draws", "#6b6b6b");
    seg(rec.losses, "losses", COLORS.red);
    container.appendChild(bar);

    const key = document.createElement("div");
    key.className = "record-key";
    const item = (n, label, colour) => {
      const s = document.createElement("span");
      s.className = "record-key-item";
      const sw = document.createElement("i");
      sw.style.background = colour;
      const t = document.createElement("span");
      t.textContent = n + " " + label;
      s.append(sw, t);
      key.appendChild(s);
    };
    item(rec.wins, "won", COLORS.green);
    item(rec.draws, "drawn", "#6b6b6b");
    item(rec.losses, "lost", COLORS.red);
    container.appendChild(key);
  }

  function shortDate(s) {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    if (isNaN(d)) return "";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return { line, recordBar, COLORS };
})();
