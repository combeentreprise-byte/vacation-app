// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // supabase/functions is Deno code (separate runtime/globals from the
    // Node-flavored RN app), not covered by this ESLint config.
    ignores: ["dist/*", "supabase/functions/**"],
  }
]);
