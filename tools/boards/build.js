"use strict";

// Draws the board styles' square textures into public/assets/boards/ as SVGs
// (walnut-light.svg, walnut-dark.svg, ...), and the Clouds fog of Fog of War
// (fog-clouds.svg). Run by hand after changing one:
//
//   node tools/boards/build.js
//
// A texture is a base colour with a pattern laid over it by an SVG noise
// filter: wood grain, marble veins, the mottle of stone. Each square shows a
// different part of its texture and its own slight shade (styles.css, "Board
// styles"), so no two tiles look alike. Never loaded by the app; the SVGs it
// writes are.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "../../public/assets/boards");

// The pattern over the base: `noise` is feTurbulence's, `alpha` turns its red
// channel into how much of `ink` shows ("k o": alpha = k * red + o), so a
// steep k with a negative o draws thin lines where the noise peaks.
const PATTERNS = {
  grain: { type: "fractalNoise", freq: "0.006 0.11", octaves: 3, alpha: "2.2 -0.85" },
  veins: { type: "turbulence", freq: "0.009", octaves: 4, alpha: "-5 1.25" },
  mottle: { type: "fractalNoise", freq: "0.035", octaves: 4, alpha: "1.6 -0.55" },
  clouds: { type: "fractalNoise", freq: "0.009", octaves: 5, alpha: "2.1 -0.62" },
};

const TEXTURES = {
  "walnut-light": { base: "#e2c08d", ink: "#a8743f", pattern: "grain", seed: 3 },
  "walnut-dark": { base: "#8b5a32", ink: "#4e2c14", pattern: "grain", seed: 8 },
  "marble-light": { base: "#efebe2", ink: "#8f948f", pattern: "veins", seed: 5 },
  "marble-dark": { base: "#71857c", ink: "#d3dbd5", pattern: "veins", seed: 11 },
  "slate-light": { base: "#c3c9cf", ink: "#7c8791", pattern: "mottle", seed: 2 },
  "slate-dark": { base: "#56626e", ink: "#2c343c", pattern: "mottle", seed: 7 },
  // Laid across a whole board, not a square at a time (styles.css).
  "fog-clouds": { base: "#4a5260", ink: "#dde2e9", pattern: "clouds", seed: 4 },
};

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3));
}

function svg({ base, ink, pattern, seed }) {
  const p = PATTERNS[pattern];
  const [r, g, b] = rgb(ink);
  const [k, o] = p.alpha.split(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">` +
    `<filter id="t" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="${p.type}" baseFrequency="${p.freq}" numOctaves="${p.octaves}" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${k} 0 0 0 ${o}"/>` +
    `</filter>` +
    `<rect width="400" height="400" fill="${base}"/><rect width="400" height="400" filter="url(#t)"/></svg>\n`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(TEXTURES)) fs.writeFileSync(path.join(OUT, name + ".svg"), svg(t));
console.log("wrote", Object.keys(TEXTURES).length, "textures to", path.relative(process.cwd(), OUT));
