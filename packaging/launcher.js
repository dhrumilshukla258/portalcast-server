#!/usr/bin/env node
// PortalCast Server launcher for the native packages (.deb / .exe / .dmg).
//
// Layout it expects (built by packaging/build-bundle.mjs):
//   <root>/node/            official Node.js runtime (bin/node or node.exe)
//   <root>/app/             dist/, public/, package.json, node_modules/ (production)
//   <root>/launcher.js      this file
//
// It:
//   - finds or creates the config file (KEY=VALUE lines) and the data directory;
//     on first run generates JWT_SECRET and writes FIRST-RUN.txt (the admin account is created
//     in the browser on the first visit: routes/account/setup.ts)
//   - runs `node dist/server.js` with cwd=app (the server serves ./public from cwd) and
//     UV_THREADPOOL_SIZE set before the process starts (libuv reads it once at startup)
//   - restarts the server if it crashes, with backoff; forwards SIGINT/SIGTERM
//   - with --log-file, also writes everything to that file (the Windows app and the
//     background service show it; it is cut at 10 MB, the previous part kept as <file>.1)
//
// Usage:
//   launcher.js                       run (foreground; used by systemd / the startup task)
//   launcher.js --init-config         only create config + data dir, print their paths
//   options: --config <file> --data <dir>   (env PORTALCAST_CONFIG / PORTALCAST_DATA also work)
//            --log-file <file>              (env PORTALCAST_LOG_FILE)
//            --stop-on-stdin-end            stop when stdin closes: how the Windows app stops the
//                                           server cleanly (Windows has no SIGTERM), and the
//                                           server never outlives the app

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "app");
const NODE_BIN = process.platform === "win32"
  ? path.join(ROOT, "node", "node.exe")
  : path.join(ROOT, "node", "bin", "node");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function defaultDirs() {
  if (process.platform === "win32") {
    const base = path.join(process.env.ProgramData || "C:\\ProgramData", "PortalCast");
    return { config: path.join(base, "portalcast.env"), data: path.join(base, "data") };
  }
  if (process.platform === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support", "PortalCast");
    return { config: path.join(base, "portalcast.env"), data: path.join(base, "data") };
  }
  // Linux: the .deb passes /etc/portalcast/portalcast.env and /var/lib/portalcast explicitly.
  const base = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "portalcast");
  return { config: path.join(base, "portalcast.env"), data: path.join(base, "data") };
}

const defaults = defaultDirs();
const CONFIG_FILE = path.resolve(arg("--config") || process.env.PORTALCAST_CONFIG || defaults.config);
const DATA_DIR = path.resolve(arg("--data") || process.env.PORTALCAST_DATA || defaults.data);
const LOG_FILE = arg("--log-file") || process.env.PORTALCAST_LOG_FILE || null;
const LOG_LIMIT = 10 * 1024 * 1024;

// Appends to LOG_FILE; past LOG_LIMIT the file becomes <file>.1 and a new one starts.
// A log that cannot be written never stops the server.
function logWriter(file) {
  let fd = null, size = 0;
  const open = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, "a");
    size = fs.fstatSync(fd).size;
  };
  try { open(); } catch (e) { console.error(`[launcher] cannot write the log ${file}: ${e.message}`); return null; }
  return (chunk) => {
    try {
      if (size > LOG_LIMIT) {
        fs.closeSync(fd);
        try { fs.renameSync(file, `${file}.1`); } catch {}
        open();
      }
      fs.writeSync(fd, chunk);
      size += Buffer.byteLength(chunk);
    } catch {}
  };
}
const writeLog = LOG_FILE ? logWriter(path.resolve(LOG_FILE)) : null;
// Local time, as the server's own lines are (the log is read by people, in the app's window).
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function say(line, err = false) {
  const text = `${line}\n`;
  (err ? process.stderr : process.stdout).write(text);
  if (writeLog) writeLog(`${stamp()} ${text}`);
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) return false;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const body = [
    "# PortalCast Server configuration. Restart the server after editing.",
    "# Full list of settings: https://github.com/dhrumilshukla258/portalcast-server/blob/main/.env.example",
    "",
    "PORT=3000",
    "NODE_ENV=production",
    `JWT_SECRET=${crypto.randomBytes(32).toString("hex")}`,
    "",
    "# The admin account is created in the browser on the first visit (like Jellyfin's setup).",
    "# Optional recovery sign-in that always works: set both and restart.",
    "# ADMIN_EMAIL=",
    "# ADMIN_PASSWORD=",
    "",
    "# Optional",
    "# TMDB_API_READ_TOKEN=      (posters, backdrops, genres for Discover)",
    "# GOOGLE_CLIENT_ID=         (Sign in with Google)",
    "# OPENSUBTITLES_API_KEY=    (subtitle search)",
    "# PUBLIC_BASE_URL=          (external URL when behind a reverse proxy)",
    "",
  ].join(os.EOL);
  fs.writeFileSync(CONFIG_FILE, body, { mode: 0o600 });
  const note = [
    "PortalCast Server — first run",
    "",
    "Open http://localhost:3000 now and create your admin account there.",
    "The first person to open the page creates it, so do it right after installing.",
    "Then Admin > Overview walks you through the rest: your IPTV provider, Jellyfin,",
    "artwork (TMDB), subtitles, users and the apps.",
    "",
    `Settings file: ${CONFIG_FILE}`,
    "",
  ].join(os.EOL);
  fs.writeFileSync(path.join(path.dirname(CONFIG_FILE), "FIRST-RUN.txt"), note, { mode: 0o600 });
  return true;
}

if (process.argv.includes("--init-config")) {
  const created = ensureConfig();
  console.log(`${created ? "Created" : "Kept existing"} config: ${CONFIG_FILE}`);
  console.log(`Data directory: ${DATA_DIR}`);
  process.exit(0);
}

const created = ensureConfig();
const fileEnv = parseEnv(fs.readFileSync(CONFIG_FILE, "utf8"));
const env = {
  ...process.env,
  UV_THREADPOOL_SIZE: "16",
  NODE_ENV: "production",
  SQLITE_DB_PATH: path.join(DATA_DIR, "database.db"),
  ...fileEnv,
};
if (created) say(`[launcher] First run: sign-in details written to ${path.join(path.dirname(CONFIG_FILE), "FIRST-RUN.txt")}`);
say(`[launcher] config ${CONFIG_FILE} | data ${DATA_DIR} | http://localhost:${env.PORT || 3000}`);

let child = null;
let stopping = false;
let failures = 0;
let startedAt = 0;

function start() {
  startedAt = Date.now();
  child = spawn(NODE_BIN, [path.join(APP_DIR, "dist", "server.js")], { cwd: APP_DIR, env, stdio: writeLog ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
  if (writeLog) {
    // The server's own lines carry their time already.
    child.stdout.on("data", (d) => { process.stdout.write(d); writeLog(d); });
    child.stderr.on("data", (d) => { process.stderr.write(d); writeLog(d); });
  }
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(code ?? 0);
    // A run that lasted a while resets the backoff; quick crash loops back off up to 60 s.
    failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1;
    const delay = Math.min(60_000, 1000 * 2 ** (failures - 1));
    say(`[launcher] server exited (${signal || code}); restarting in ${Math.round(delay / 1000)} s`, true);
    setTimeout(start, delay);
  });
}

function stop(why) {
  if (stopping) return;
  stopping = true;
  say(`[launcher] stopping (${why})`);
  if (child) child.kill("SIGTERM");
  else process.exit(0);
  setTimeout(() => process.exit(0), 10_000).unref();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(sig));
if (process.argv.includes("--stop-on-stdin-end")) {
  process.stdin.on("end", () => stop("the app closed"));
  process.stdin.on("error", () => stop("the app closed"));
  process.stdin.resume();
}

start();
