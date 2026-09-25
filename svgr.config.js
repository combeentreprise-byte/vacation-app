// Applies to every *.svg imported as a component (see metro.config.js and
// src/utils/hero-motive.ts). Motive source files are flat-color traces
// (fill="#000000" on the outermost <g>, see assets/motives/) — this rewrites
// that hardcoded black to `currentColor` so HeroMotive can recolor the whole
// illustration at runtime via a single `color` prop, without hand-editing
// every motive file.
module.exports = {
  replaceAttrValues: {
    "#000000": "currentColor",
    "#000": "currentColor",
  },
};
