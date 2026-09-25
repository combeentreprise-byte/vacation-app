const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro doesn't resolve .mjs files by default, which breaks packages like
// @supabase/supabase-js and its sub-dependencies that ship ESM builds.
config.resolver.sourceExts.push("mjs");

// Hero motive illustrations (assets/motives/*.svg) are imported as React
// components (see src/utils/hero-motive.ts) rather than loaded as static
// image assets, so they can be recolored at runtime via a `color` prop
// instead of shipping one flat-color PNG per motive per palette color.
config.transformer.babelTransformerPath = require.resolve("react-native-svg-transformer/expo");
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== "svg");
config.resolver.sourceExts.push("svg");

module.exports = config;
