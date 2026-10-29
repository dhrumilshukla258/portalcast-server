#!/usr/bin/env node
// The node_modules the packaged server needs at runtime: only what sqlite3 (the one dependency
// not bundled into dist/server.js, tsup.config.ts) loads — its JavaScript, its compiled
// driver, `bindings` — plus each of those packages' package.json. About a hundred files instead
// of the thousands a full production node_modules has.
//
//   node packaging/runtime-modules.mjs <out dir>      (run from the repo root after npm ci)
//
// Used by packaging/build-bundle.mjs (.exe, .deb, .dmg, .tar.gz, .zip) and the Dockerfile.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const out = process.argv[2];
if (!out) {
  console.error("usage: runtime-modules.mjs <out dir>");
  process.exit(2);
}
const root = path.resolve("node_modules");
const require = createRequire(path.resolve("package.json"));

// Loading the driver opens its native file too, which then shows in the module cache.
require("sqlite3");
const loaded = Object.keys(require.cache).filter((f) => f.startsWith(root + path.sep));
if (!loaded.some((f) => f.endsWith(".node"))) {
  console.error("sqlite3's native driver was not loaded: run npm ci first");
  process.exit(1);
}

/** The package folder a file belongs to (handles @scope/name). */
function packageDir(file) {
  const parts = path.relative(root, file).split(path.sep);
  const n = parts[0].startsWith("@") ? 2 : 1;
  return path.join(root, ...parts.slice(0, n));
}

fs.rmSync(out, { recursive: true, force: true });
const copied = new Set();
const copy = (file) => {
  if (copied.has(file)) return;
  copied.add(file);
  const dest = path.join(out, path.relative(root, file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
};
for (const file of loaded) {
  copy(file);
  const pkg = path.join(packageDir(file), "package.json");
  if (fs.existsSync(pkg)) copy(pkg);
  // Files a package loads only later (sqlite3's ./trace in verbose mode) sit beside the ones
  // loaded now: the .js and .json of each folder come along.
  for (const name of fs.readdirSync(path.dirname(file))) {
    const sib = path.join(path.dirname(file), name);
    if (/\.(c?js|json)$/.test(name) && fs.statSync(sib).isFile()) copy(sib);
  }
}
const bytes = [...copied].reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`runtime node_modules: ${copied.size} files, ${(bytes / 1048576).toFixed(1)} MB -> ${path.resolve(out)}`);
