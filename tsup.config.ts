import { defineConfig } from "tsup";
import path from "path";

// Every dependency is bundled into dist/server.js except these: sqlite3 (a native driver, the
// only one the packages ship in node_modules: packaging/runtime-modules.mjs, about a hundred
// files instead of thousands) and optional modules a dependency only tries to load (absent
// at runtime, which those dependencies expect).
const EXTERNAL = ["sqlite3", "bufferutil", "utf-8-validate", "pg-native", "pg-hstore"];

export default defineConfig({
  entry: ["src/server.ts"],
  outDir: "dist",
  format: ["cjs"],
  target: "node20",
  clean: true,
  sourcemap: true,
  tsconfig: "./tsconfig.json",
  noExternal: [new RegExp(`^(?!(${EXTERNAL.join("|")})(/|$)).*`)],
  external: EXTERNAL,
  // Official builds get the OpenSubtitles key from a GitHub secret (content/builtInKeys.ts).
  define: {
    __PORTALCAST_OPENSUBTITLES_KEY__: JSON.stringify(process.env.PORTALCAST_OPENSUBTITLES_KEY ?? ""),
  },
  esbuildOptions(options) {
    options.alias = {
      "@": path.resolve(__dirname, "src"),
    };
  },
});
