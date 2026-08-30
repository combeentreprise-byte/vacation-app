const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro doesn't resolve .mjs files by default, which breaks packages like
// @supabase/supabase-js and its sub-dependencies that ship ESM builds.
config.resolver.sourceExts.push("mjs");

module.exports = config;
