"use strict";

// Draws LorChess's own piece sets into public/assets/pieces/<set>/ as twelve
// SVGs each (wK.svg ... bP.svg): "LorChess Staunton" (lorchess), carved
// pieces on stepped bases, "LorChess Modern" (modern), bold one-piece
// silhouettes in the manner of the big sites' sets, and "LorChess Simple"
// (simple), the plainest shapes, flat, with almost no lines; all drawn here,
// none traced.
// Run by hand after changing a shape or a colour:
//
//   node tools/pieces/build.js
//
// Each piece is a list of shapes drawn in a 100 x 100 box, standing on y = 92,
// so the two colours always share one drawing: `d` a filled, outlined shape,
// `line` a detail drawn inside it, `dot` a small solid mark (the knight's eye
// and nostril), and `group` shapes drawn larger (see draw). Never loaded by
// the app; the SVGs it writes are.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "../../public/assets/pieces");

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

// The knight's head and neck, standing on y = 78.5: shared by both sets.
function knightHead() {
  return [
    {
      // Facing left: the chest, the throat, the jaw forward to the chin, the
      // nose, the face and forehead up to the ear, then the arched back of
      // the neck.
      d: "M25.5 78.5 C25.5 69 29.5 62 37 58.5 C40.5 56.5 41.5 54 39.5 52 C34 54.5 27 57.5 22 57" +
        " C18 56.5 16 54 17 51 C15 49 13 46 15 43 C18 36 26 27 35 19 C38 16 41 13 44 11" +
        " C44.5 7.5 45.5 5 47.5 2.5 C50 5.5 51.5 9 51.5 12.5 C60 12 68 17 73 25 C80 36 82 56 77 78.5 Z",
    },
    { dot: "M30 31 C31.5 28.5 35 28 37 30.5 C35 33 31.5 33.5 30 31 Z" },
    { line: "M29.5 26.5 C32 24.3 36 24.3 39 27" },
    { dot: circle(18.6, 46.6, 1.6).d },
    { line: "M17.8 52 L22.5 51" },
    { line: "M52 13 C63 18 71 30 73 52" },
    { line: "M40 30 C44 37 44 46 39 52.5" },
  ];
}

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
  n: [...base(70), ...knightHead()],
};

// A piece drawn larger than its shapes, from the middle of its foot, with its
// lines kept the same weight as every other piece's. The pawn is drawn a bit
// bigger than its shapes, to stand up among the others.
const SCALE = { p: 1.06 };

// "LorChess Modern": every piece one bold silhouette on a broad rounded foot,
// no stepped base, a soft light-to-shade fill and a heavier outline, with
// lines across it where a carved piece would have its collars.
const MODERN_PALETTES = {
  w: { top: "#ffffff", bottom: "#dcdcdc", stroke: "#1a1a1a", line: "#1a1a1a" },
  b: { top: "#5a5a5a", bottom: "#1b1b1b", stroke: "#0a0a0a", line: "#e9e9e9" },
};
// The rounded foot under the knight, which has no body to flare into one.
const FOOT = "M21 92 C21 86 26 83 33 82.5 H67 C74 83 79 86 79 92 Z";

const MODERN = {
  p: [
    {
      d: "M25 92 C25 82 33 74 42 69.5 C39.5 66 38.5 61 39.5 57 H36 C34 57 32.5 55.5 32.5 53.8" +
        " C32.5 52 34 50.5 36 50.5 H64 C66 50.5 67.5 52 67.5 53.8 C67.5 55.5 66 57 64 57 H60.5" +
        " C61.5 61 60.5 66 58 69.5 C67 74 75 82 75 92 Z",
    },
    circle(50, 36.5, 14),
  ],
  r: [
    {
      d: "M21 92 V86 C21 83.5 23 81.5 26 81.5 H29.5 L31.5 50.5 H28.5 C26.5 50.5 25 49 25 47 V20 H36.5 V27.5" +
        " H45 V20 H55 V27.5 H63.5 V20 H75 V47 C75 49 73.5 50.5 71.5 50.5 H68.5 L70.5 81.5 H74" +
        " C77 81.5 79 83.5 79 86 V92 Z",
    },
    { line: "M31.5 50.5 H68.5" },
    { line: "M29.5 81.5 H70.5" },
  ],
  b: [
    circle(50, 11, 5.5),
    {
      d: "M21 92 C21 86 26.5 82.5 34 82 C33 79 33.5 76 35 74 C38 70 41 66 42 60.5 H39.5 C37.3 60.5 35.5 59 35.5 57" +
        " C35.5 55 37.3 53.5 39.5 53.5 H40.5 C33 48.5 31 40.5 35 32.5 C38 26.5 44 21 50 16 C56 21 62 26.5 65 32.5" +
        " C69 40.5 67 48.5 59.5 53.5 H60.5 C62.7 53.5 64.5 55 64.5 57 C64.5 59 62.7 60.5 60.5 60.5 H58" +
        " C59 66 62 70 65 74 C66.5 76 67 79 66 82 C73.5 82.5 79 86 79 92 Z",
    },
    { line: "M57.5 29.5 L48.5 41.5" },
    { line: "M34 82 H66" },
  ],
  q: [
    circle(22.5, 26.5, 4.2), circle(37, 19.5, 4.2), circle(50, 14.5, 4.6), circle(63, 19.5, 4.2), circle(77.5, 26.5, 4.2),
    {
      d: "M21 92 C21 86 26.5 82.5 33 82 L36 72 C38 66 39 61 38 57 L23 30 L36 41 L37.5 23.5 L46 38.5 L50 19" +
        " L54 38.5 L62.5 23.5 L64 41 L77 30 L62 57 C61 61 62 66 64 72 L67 82 C73.5 82.5 79 86 79 92 Z",
    },
    { line: "M38 57 H62" },
    { line: "M33 82 H67" },
  ],
  k: [
    { d: "M47 5 H53 V11 H59 V17 H53 V40 H47 V17 H41 V11 H47 Z" },
    {
      d: "M21 92 C21 86 26.5 82.5 33 82 L36 72 C38 66 39 61.5 38 57.5 C26 54 19.5 45 24.5 36.5" +
        " C29.5 28 41.5 27 46.5 33.5 L50 38 L53.5 33.5 C58.5 27 70.5 28 75.5 36.5 C80.5 45 74 54 62 57.5" +
        " C61 61.5 62 66 64 72 L67 82 C73.5 82.5 79 86 79 92 Z",
    },
    { line: "M38 57.5 H62" },
    { line: "M33 82 H67" },
  ],
  n: [
    { d: FOOT },
    { group: { k: 1.06, from: 78.5, at: 84 }, shapes: knightHead() },
  ],
};

// "LorChess Simple": flat white and near-black, a bold outline, the plainest
// silhouettes, and only the lines a piece can't be told without (the
// bishop's slit, the knight's eye).
const SIMPLE_PALETTES = {
  w: { top: "#ffffff", bottom: "#ffffff", stroke: "#111111", line: "#111111" },
  b: { top: "#222222", bottom: "#222222", stroke: "#000000", line: "#ffffff" },
};
const SIMPLE = {
  p: [
    { d: "M26 91 C26 79 34 71 43 66 L45.5 49 H54.5 L57 66 C66 71 74 79 74 91 Z" },
    circle(50, 36, 14),
  ],
  r: [
    {
      d: "M22 91 V83 C22 81.5 23 80.5 24.5 80.5 H30 L32 49 H28 C26.5 49 25.5 48 25.5 46.5 V21 H36 V28.5" +
        " H45 V21 H55 V28.5 H64 V21 H74.5 V46.5 C74.5 48 73.5 49 72 49 H68 L70 80.5 H75.5" +
        " C77 80.5 78 81.5 78 83 V91 Z",
    },
  ],
  b: [
    circle(50, 12.5, 6),
    {
      d: "M23 91 C23 84 29 80.5 37 80 C37 72 39.5 64 43.5 58 C34 53 31 43 36 34 C40 27 45 22 50 18" +
        " C55 22 60 27 64 34 C69 43 66 53 56.5 58 C60.5 64 63 72 63 80 C71 80.5 77 84 77 91 Z",
    },
    { line: "M57 32 L49 43" },
  ],
  q: [
    circle(24, 26.5, 4.3), circle(38.5, 18, 4.3), circle(50, 13, 4.6), circle(61.5, 18, 4.3), circle(76, 26.5, 4.3),
    {
      d: "M22 91 C22 84 28 80.5 35 80 L38 66 L24 30 L37 44 L38.5 22 L46 41 L50 17 L54 41 L61.5 22 L63 44" +
        " L76 30 L62 66 L65 80 C72 80.5 78 84 78 91 Z",
    },
  ],
  k: [
    { d: "M47 4 H53 V11 H60 V17 H53 V31 H47 V17 H40 V11 H47 Z" },
    {
      d: "M22 91 C22 84 28 80.5 35 80 L38 66 C30 60 24 52 26 42 C28 33 38 28.5 50 30 C62 28.5 72 33 74 42" +
        " C76 52 70 60 62 66 L65 80 C72 80.5 78 84 78 91 Z",
    },
  ],
  n: [
    { d: FOOT },
    { group: { k: 1.06, from: 78.5, at: 84 }, shapes: [knightHead()[0], knightHead()[1]] },
  ],
};

const SETS = [
  { dir: "lorchess", palettes: PALETTES, pieces: PIECES, scale: SCALE, outline: 2.6, detail: 1.8 },
  { dir: "modern", palettes: MODERN_PALETTES, pieces: MODERN, scale: {}, outline: 3.4, detail: 2.4 },
  { dir: "simple", palettes: SIMPLE_PALETTES, pieces: SIMPLE, scale: {}, outline: 3.6, detail: 2.8 },
];

// A list of shapes in a colour's palette: the gradient they fill with (`defs`,
// its id `id`) and the paths (`body`), scaled by `k` from the middle of the
// foot with the lines kept at every piece's weight. A `group` is drawn `k`
// times larger, its foot line `from` moved to `at`, its lines kept at weight.
function draw(set, shapes, colour, id, k = 1) {
  const p = set.palettes[colour];
  const paths = (list, scale) => list.map((s) => {
    const w = (n) => +(n / scale).toFixed(2);
    if (s.group) {
      const g = s.group;
      return `<g transform="translate(50 ${g.at}) scale(${g.k}) translate(-50 -${g.from})">` +
        paths(s.shapes, scale * g.k) + `</g>`;
    }
    return s.line
      ? `<path d="${s.line}" fill="none" stroke="${p.line}" stroke-width="${w(set.detail)}" stroke-linecap="round"/>`
      : s.dot
        ? `<path d="${s.dot}" fill="${p.line}"/>`
        : `<path d="${s.d}" fill="url(#${id})" stroke="${p.stroke}" stroke-width="${w(set.outline)}" stroke-linejoin="round"/>`;
  }).join("");
  return {
    defs: `<linearGradient id="${id}" x1="0.2" y1="0" x2="0.8" y2="1">` +
      `<stop offset="0" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}"/></linearGradient>`,
    body: k === 1 ? paths(shapes, 1) : `<g transform="translate(50 92) scale(${k}) translate(-50 -92)">${paths(shapes, k)}</g>`,
  };
}

function svg(set, colour, type) {
  const { defs, body } = draw(set, set.pieces[type], colour, `g${colour}${type}`, set.scale[type] || 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>\n`;
}

for (const set of SETS) {
  const dir = path.join(OUT, set.dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of ["w", "b"]) {
    for (const t of Object.keys(set.pieces)) {
      fs.writeFileSync(path.join(dir, `${c}${t.toUpperCase()}.svg`), svg(set, c, t));
    }
  }
  console.log("wrote 12 pieces to", path.relative(process.cwd(), dir));
}
