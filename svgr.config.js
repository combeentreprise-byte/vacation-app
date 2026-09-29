// Applies to every *.svg imported as a component (see metro.config.js and
// src/utils/hero-motive.ts). Motive source files are flat-color traces
// (fill="#000000" on the outermost <g>, see assets/motives/) — this rewrites
// that hardcoded black to `currentColor` so HeroMotive can recolor the whole
// illustration at runtime via a single `color` prop, without hand-editing
// every motive file.
//
// VTracer-traced motives (scripts/normalize-motives.js) also draw light
// "hole" shapes on top of the dark art, normalized to #FFFFFF — those map to
// a `holeColor` prop so HeroMotive can paint them the hero's background.
// The custom template destructures `holeColor` out of props rather than
// letting it spread onto <Svg> — on web react-native-svg forwards unknown
// props straight to the DOM, which React warns about.
module.exports = {
  replaceAttrValues: {
    "#000000": "currentColor",
    "#000": "currentColor",
    "#FFFFFF": "{holeColor}",
  },
  template: ({ imports, interfaces, componentName, jsx, exports }, { tpl }) => tpl`
${imports};
${interfaces};
const ${componentName} = ({ holeColor, ...props }) => ${jsx};
${exports};
`,
};
