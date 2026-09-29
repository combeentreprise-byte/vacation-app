// Converts VTracer-traced motive SVGs (assets/motives-originals/) into the
// two-color form HeroMotive expects, writing the result to assets/motives/.
// Safe to re-run: it always reads from the untouched originals.
//
// VTracer output differs from the older potrace-style motives in three ways
// this fixes:
// - Hundreds of near-black fills (#00103D, #011137, ...) → one #000000,
//   which svgr.config.js rewrites to `currentColor` (the line hue).
// - Light "hole" shapes drawn *on top of* the dark ones (window panes, gaps
//   between waves) → #FFFFFF, which svgr.config.js rewrites to the
//   `holeColor` prop so they match the hero's pastel background.
// - A full-canvas off-white background rectangle (always the first path) is
//   dropped, and a viewBox is added so percentage sizing scales correctly.
//
// Usage: node scripts/normalize-motives.js
/* global __dirname */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "assets");
const SOURCE_DIR = path.join(ROOT, "motives-originals");
const TARGET_DIR = path.join(ROOT, "motives");

// Source filename → output filename (renamed where the original isn't a
// clean import path).
const RENAMES = { "new york.svg": "new-york.svg" };

const LIGHTNESS_THRESHOLD = 128;

// Per-motive shrink factor (1 = as traced), applied by widening the viewBox
// around its center so the art shrinks toward the middle of its frame. Tuned
// so each drawing's bottom edge lands ~81% down its canvas like new-york's —
// otherwise it runs into the name ribbon on the group list cards (which
// top-align the motive, see (tabs)/index.tsx).
const SCALES = {
  "beach1.svg": 0.8,
  "beach2.svg": 0.83,
  "beach3.svg": 0.8,
  "mountainrange1.svg": 0.95,
  "mountainrange2.svg": 0.92,
  "mountainrange3.svg": 0.86,
};

function lightness(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r + g + b) / 3;
}

for (const file of fs.readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".svg"))) {
  let svg = fs.readFileSync(path.join(SOURCE_DIR, file), "utf8");

  const size = svg.match(/<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"[^>]*\bheight="(\d+(?:\.\d+)?)"/);
  if (!size) throw new Error(`${file}: no width/height on <svg>`);
  const [, width, height] = size;

  // The first <path> is VTracer's full-canvas background rectangle.
  svg = svg.replace(/<path\b[^>]*\/>\s*/, "");

  const scale = SCALES[file] ?? 1;
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  const round = (n) => Math.round(n * 10) / 10;
  const viewBox = [
    round((width - viewWidth) / 2),
    round((height - viewHeight) / 2),
    round(viewWidth),
    round(viewHeight),
  ].join(" ");
  svg = svg.replace(/<svg\b([^>]*)>/, (_, attrs) => {
    return `<svg${attrs} viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`;
  });

  svg = svg.replace(/fill="#([0-9A-Fa-f]{6})"/g, (_, hex) =>
    lightness(hex) > LIGHTNESS_THRESHOLD ? 'fill="#FFFFFF"' : 'fill="#000000"',
  );

  const outName = RENAMES[file] ?? file;
  fs.writeFileSync(path.join(TARGET_DIR, outName), svg);
  if (outName !== file && fs.existsSync(path.join(TARGET_DIR, file))) {
    fs.unlinkSync(path.join(TARGET_DIR, file));
  }
  console.log(`${file} → motives/${outName}`);
}
