#!/usr/bin/env node
// Assemble the portable PortalCast Server bundle used by every native package.
//
//   node packaging/build-bundle.mjs --node <extracted Node.js dir> --out <bundle dir>
//
// Run from the repo root AFTER `npm ci && npm run build`, on the
// same OS/CPU as the target (node_modules holds the native sqlite3 binary for it).
// The Node.js runtime must be the same major version that ran `npm ci` (ABI match).
//
// Output:
//   <out>/node/          Node.js runtime (bin/node or node.exe, + its licence)
//   <out>/app/           dist/ (the server, dependencies bundled in), public/, package.json,
//                        node_modules/ (only sqlite3's driver: packaging/runtime-modules.mjs)
//   <out>/launcher.js    packaging/launcher.js
//   <out>/README.txt

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const nodeDir = arg("--node");
const out = arg("--out");
if (!nodeDir || !out) {
  console.error("usage: build-bundle.mjs --node <node dir> --out <bundle dir>");
  process.exit(2);
}
for (const required of ["dist/server.js", "public/index.html", "node_modules/sqlite3"]) {
  if (!fs.existsSync(required)) {
    console.error(`missing ${required}: run npm ci && npm run build first`);
    process.exit(1);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "app"), { recursive: true });

const copy = (src, dst) => fs.cpSync(src, dst, { recursive: true, dereference: true });
for (const item of ["dist/server.js", "public", "package.json"]) copy(item, path.join(out, "app", item));
// Not the whole node_modules: dist/server.js has every dependency bundled except sqlite3.
execFileSync(process.execPath, ["packaging/runtime-modules.mjs", path.join(out, "app", "node_modules")], { stdio: "inherit" });
copy(nodeDir, path.join(out, "node"));
// Not needed at runtime: npm/corepack/headers inside the Node.js distribution.
for (const extra of ["include", "share", "lib/node_modules", "node_modules", "npm", "npm.cmd", "npx", "npx.cmd", "corepack", "corepack.cmd", "bin/npm", "bin/npx", "bin/corepack"]) {
  fs.rmSync(path.join(out, "node", extra), { recursive: true, force: true });
}
copy("packaging/launcher.js", path.join(out, "launcher.js"));

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
fs.writeFileSync(path.join(out, "README.txt"), [
  `PortalCast Server ${process.env.PORTALCAST_VERSION || version}`,
  "",
  "Start:   node/bin/node launcher.js      (Windows: node\\node.exe launcher.js)",
  "Open:    http://localhost:3000",
  "",
  "First run creates the config file and FIRST-RUN.txt with the admin sign-in.",
  "  Linux (.deb):  /etc/portalcast/portalcast.env, data in /var/lib/portalcast",
  "  Windows:       C:\\ProgramData\\PortalCast\\portalcast.env",
  "  macOS:         ~/Library/Application Support/PortalCast/portalcast.env",
  "",
  "Optional: install ffmpeg (on PATH) for HEVC live / VOD transcoding.",
  "",
].join("\n"));

console.log(`bundle ready: ${path.resolve(out)}`);
