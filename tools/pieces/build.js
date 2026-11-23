"use strict";

// Draws LorChess's own piece set, "LorChess Staunton", into
// public/assets/pieces/lorchess/ as twelve SVGs (wK.svg ... bP.svg). Run by
// hand after changing a shape or a colour:
//
//   node tools/pieces/build.js
//
// Each piece is a list of shapes drawn in a 100 x 100 box, standing on y = 92,
// so the two colours always share one drawing: `d` a filled, outlined shape,
// `line` a detail drawn inside it, `dot` a small solid mark (the knight's eye
// and nostril). Never loaded by the app; the SVGs it writes are.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "../../public/assets/pieces/lorchess");

// Ivory and near-black, each outlined dark so it reads on light and dark
// squares alike; `line` draws the details inside a piece.
const PALETTES = {
  w: { top: "#fffcf3", bottom: "#e4d8be", stroke: "#2a241c", line: "#2a241c" },
  b: { top: "#4a4a50", bottom: "#17171a", stroke: "#0c0c0e", line: "#a8a196" },
};

// A rounded box: x0..x1, y0..y1, corner r.
function box(x0, y0, x1, y1, r) {
  return `M${x0 + r} ${y0} H${x1 - r} Q${x1} ${y0} ${x1} ${y0 + r} V${y1 - r} Q${x1} ${y1} ${x1 - r} ${y1}` +
    ` H${x0 + r} Q${x0} ${y1} ${x0} ${y1 - r} V${y0 + r} Q${x0} ${y0} ${x0 + r} ${y0} Z`;
}
// The two-step base every piece stands on, `w` wide at the foot.
function base(w) {
  const h = w / 2;
  return [
    { d: box(50 - h, 84, 50 + h, 92, 3) },
    { d: box(50 - h + 6, 78, 50 + h - 6, 84.5, 2) },
  ];
}
const circle = (cx, cy, r) => ({ d: `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z` });

const PIECES = {
  p: [
    ...base(60),
    { d: "M30 78.5 C34 69 40 61 41 54 H59 C60 61 66 69 70 78.5 Z" },
    { d: box(32, 47, 68, 54.5, 3) },
    circle(50, 33.5, 15),
  ],
  r: [
    ...base(70),
    { d: "M27 78.5 L31 42 H69 L73 78.5 Z" },
    { d: box(25, 35, 75, 42.5, 1.5) },
    { d: "M24 35.5 V15 H35 V23 H44.5 V15 H55.5 V23 H65 V15 H76 V35.5 Z" },
    { line: "M31 49 H69" },
  ],
  b: [
    ...base(64),
    { d: "M30 78.5 C35 69 40 61 41 52 H59 C60 61 65 69 70 78.5 Z" },
    { d: box(33, 45.5, 67, 52.5, 3) },
    { d: "M36 46 C28 37 34 26 50 13 C66 26 72 37 64 46 Z" },
    circle(50, 9.5, 5),
    { line: "M58 23.5 L47 37.5" },
  ],
  q: [
    ...base(72),
    { d: "M27 78.5 C33 67 38 57 39.5 48 H60.5 C62 57 67 67 73 78.5 Z" },
    { d: box(32, 42.5, 68, 49.5, 3) },
    { d: "M33 43 L22 21 L35 32 L37 13 L44.5 30 L50 9 L55.5 30 L63 13 L65 32 L78 21 L67 43 Z" },
    circle(22, 19, 3.8), circle(37, 11, 3.8), circle(50, 7, 4), circle(63, 11, 3.8), circle(78, 19, 3.8),
  ],
  k: [
    ...base(72),
    { d: "M27 78.5 C33 67 38 57 39.5 48 H60.5 C62 57 67 67 73 78.5 Z" },
    { d: box(32, 42.5, 68, 49.5, 3) },
    { d: "M47 3 H53 V8.5 H58.5 V14.5 H53 V25 H47 V14.5 H41.5 V8.5 H47 Z" },
    { d: "M33.5 43 C26 33 29 23.5 40.5 23 C45 22.8 48.5 25 50 27.5 C51.5 25 55 22.8 59.5 23 C71 23.5 74 33 66.5 43 Z" },
  ],
  n: [
    ...base(70),
    {
      d: "M76 78.5 C80 60 77 40 67 24 C65 18 62 12 59 6 L53.5 14.5 C45 14.5 37 18.5 32 24.5" +
        " C26 31 20 39 16 47.5 C14 52.5 16 57.5 21.5 58.5 C24.5 59 27 57.5 28.5 56.5" +
        " C32.5 56.5 36.5 55.5 40.5 53 C44 51.5 48 53.5 47.5 57.5 C45 65 36 71 31 78.5 Z",
    },
    { dot: circle(38.5, 29.5, 2.6).d },
    { dot: circle(22.5, 51, 1.6).d },
    { line: "M68 25 C73 38 75 54 74 68" },
    { line: "M28.5 56.5 L33.5 54" },
  ],
};

// A piece drawn larger than its shapes, from the middle of its foot, with its
// lines kept the same weight as every other piece's. The pawn is drawn a bit
// bigger than its shapes, to stand up among the others.
const SCALE = { p: 1.06 };

function svg(colour, type) {
  const p = PALETTES[colour];
  const id = `g${colour}${type}`;
  const k = SCALE[type] || 1;
  const w = (n) => +(n / k).toFixed(2);
  const shapes = PIECES[type].map((s) => (s.line
    ? `<path d="${s.line}" fill="none" stroke="${p.line}" stroke-width="${w(1.8)}" stroke-linecap="round"/>`
    : s.dot
      ? `<path d="${s.dot}" fill="${p.line}"/>`
      : `<path d="${s.d}" fill="url(#${id})" stroke="${p.stroke}" stroke-width="${w(2.6)}" stroke-linejoin="round"/>`));
  const body = k === 1 ? shapes.join("") : `<g transform="translate(50 92) scale(${k}) translate(-50 -92)">${shapes.join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="${id}" x1="0.2" y1="0" x2="0.8" y2="1">` +
    `<stop offset="0" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}"/></linearGradient></defs>` +
    body + `</svg>\n`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const c of ["w", "b"]) {
  for (const t of Object.keys(PIECES)) {
    fs.writeFileSync(path.join(OUT, `${c}${t.toUpperCase()}.svg`), svg(c, t));
  }
}
console.log("wrote 12 pieces to", path.relative(process.cwd(), OUT));
