import { defineConfig } from "tsup";
import path from "path";

export default defineConfig({
  entry: ["src/server.ts"],
  outDir: "dist",
  format: ["cjs"],
  target: "node20",
  clean: true,
  sourcemap: true,
  tsconfig: "./tsconfig.json",
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
