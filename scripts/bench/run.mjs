// Benchmark runner: starts the mock Xtream upstream (./mockXtream.mjs) and a real
// portalcast-server (src/server.ts via tsx) on a throwaway SQLite DB, warms the catalog + EPG
// through the server's own admin routes, then times the hot /api/v2 read endpoints.
//
//   node scripts/bench/run.mjs [--fresh] [--runs=10] [--label=before] [--port=18080] [--mock-port=18081]
//
// --fresh   delete the bench DB and rebuild it (refresh/warm/EPG take a few minutes). Without
//           it an existing bench DB is reused (the mock is deterministic, so the catalog is the
//           same; the EPG stays valid for ~a day because the mock anchors it on its build hour).
// Results print as a markdown table and are saved as JSON under the bench directory.
// See scripts/bench/README.md.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { startMock } from "./mockXtream.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const RUNS = Number(args.runs) || 10;
const PORT = Number(args.port) || 18080;
const MOCK_PORT = Number(args["mock-port"]) || 18081;
const LABEL = String(args.label || "run");
const BENCH_DIR = process.env.BENCH_DIR || path.join(os.tmpdir(), "portalcast-bench");
const DB_PATH = path.join(BENCH_DIR, "bench.db");
const ANCHOR_FILE = path.join(BENCH_DIR, "anchor.json");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_PASSWORD = "bench-admin-pw";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ── HTTP helper: measures wall time to last byte, wire (gzip) and raw sizes ──────────────
function request(method, urlPath, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // Non-GET requests always carry a JSON body: hapi resets a bodiless chunked POST.
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : method !== "GET" ? Buffer.from("{}") : undefined;
    const t0 = process.hrtime.bigint();
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        agent: false, // fresh connection per request: reused keep-alive sockets got ECONNRESET from the server
        path: urlPath,
        headers: {
          "Accept-Encoding": "gzip",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          const wire = Buffer.concat(chunks);
          const raw = res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(wire) : wire;
          resolve({ status: res.statusCode, ms, wireBytes: wire.length, rawBytes: raw.length, headers: res.headers, raw });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (r) => {
  try { return JSON.parse(r.raw.toString("utf8")); } catch { return undefined; }
};

// ── Process memory (Windows: Get-Process; elsewhere: ps) ─────────────────────────────────
function memOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        `$p=Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.PrivateMemorySize64)"`], { encoding: "utf8" }).trim();
      const [ws, peak, priv] = out.split(/\s+/).map(Number);
      return { rssMB: ws / 2 ** 20, peakMB: peak / 2 ** 20, privateMB: priv / 2 ** 20 };
    }
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return { rssMB: kb / 1024, peakMB: NaN, privateMB: NaN };
  } catch {
    return { rssMB: NaN, peakMB: NaN, privateMB: NaN };
  }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────────────────
let serverProc;
const serverLog = [];
function startServer() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    SQLITE_DB_PATH: DB_PATH,
    JWT_SECRET: "bench-jwt-secret-bench-jwt-secret",
    ADMIN_PASSWORD,
    ADMIN_EMAIL: "bench@example.invalid",
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    TMDB_API_READ_TOKEN: "",
    OPENSUBTITLES_API_KEY: "",
    EPG_FETCH_BATCH_DELAY_MS: "0", // the 500 ms production pause would make a 10k-channel fetch take ~17 min
  };
  serverProc = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (d) => {
    for (const line of d.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
      serverLog.push(clean);
      if (serverLog.length > 20000) serverLog.splice(0, 10000);
      if (args.verbose || /error|ERROR|FATAL/.test(clean)) console.log("  [server]", clean.slice(0, 300));
    }
  };
  serverProc.stdout.on("data", onData);
  serverProc.stderr.on("data", onData);
  serverProc.on("exit", (code) => log(`server exited (${code})`));
}
async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await request("GET", "/api/v2/expiry");
      if (r.status) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not start");
}
function stopServer() {
  if (serverProc && serverProc.exitCode === null) serverProc.kill();
}
const countLog = (re) => serverLog.filter((l) => re.test(l)).length;

// ── Setup (fresh DB): profile + refresh/warm/EPG through the admin routes ────────────────
async function setup(token, mock) {
  const cfg = {
    providerType: "xtream", hostname: "127.0.0.1", port: MOCK_PORT, https: false,
    username: "bench", password: "bench", contextPath: "", mac: "00:1A:79:00:00:00", stbType: "MAG254",
    groups: [], proxy: false, tokens: [], playCensored: false,
  };
  const created = await request("POST", "/api/profiles", { token, body: { name: "bench-xtream", config: cfg } });
  const profile = json(created);
  if (created.status !== 201) throw new Error(`create profile: ${created.status} ${created.raw}`);
  const act = await request("POST", `/api/profiles/${profile.id}/activate`, { token });
  if (act.status !== 200) throw new Error(`activate: ${act.status} ${act.raw}`);
  log(`profile ${profile.id} active`);

  // isNativeSeriesSource() memoizes portal_series_source for 5 s and the startup warm just
  // cached "not native" — refreshing series groups inside that window would warm series
  // against get_vod_streams and find nothing.
  await sleep(6000);
  const t0 = Date.now();
  const epgBaseline = countLog(/EPG cache updated/);
  for (const p of ["/api/v2/refresh-groups", "/api/v2/refresh-channels", "/api/v2/refresh-movie-groups", "/api/v2/refresh-series-groups"]) {
    const r = await request("GET", p, { token });
    log(`${p} -> ${r.status} (${r.ms.toFixed(0)} ms)`);
  }
  for (const p of ["/api/v2/warm-xtream-vod", "/api/v2/warm-xtream-series", "/api/v2/refresh-epg"]) {
    const r = await request("POST", p, { token });
    log(`${p} -> ${r.status}`);
  }
  const vodCats = mock.catalog.vodCategories.length;
  const seriesCats = mock.catalog.seriesCategories.length;
  for (;;) {
    const vod = countLog(/\[XtreamVOD\] vod_streams_\S+: warmed/);
    const ser = countLog(/\[XtreamSeries\] series_list_\S+: warmed/);
    const epg = countLog(/EPG cache updated/) - epgBaseline;
    log(`warming… vod ${vod}/${vodCats}, series ${ser}/${seriesCats}, epg ${epg ? "done" : "running"}, upstream reqs ${mock.stats.requests} ${args.verbose ? JSON.stringify(mock.stats.byAction) : ""}`);
    if (vod >= vodCats && ser >= seriesCats && epg >= 1) break;
    if (Date.now() - t0 > 60 * 60 * 1000) throw new Error("warm timed out");
    await sleep(5000);
  }
  log(`warm + EPG done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// On a reused DB the server's own startup warm (re-check every category, cleanupGenres) runs
// first and keeps the event loop busy; timing under it measures the warm, not the endpoint.
// warmSeriesInfoCache starting means the warm + cleanup are done (it then trickles one
// upstream call per 500 ms, which is light).
async function waitStartupWarm() {
  for (let i = 0; i < 600; i++) {
    if (countLog(/\[XtreamSeriesInfo\]/) > 0) return;
    if (i % 10 === 0) log("waiting for the startup warm to finish…");
    await sleep(1000);
  }
  log("WARNING: startup warm did not finish within 10 min");
}

// The warm fires ~2 unawaited SQLite upserts per movie (vod_info_/vod_cmd_); wait until the
// write queue has drained (a DB-backed request is fast again) before timing anything.
async function waitQuiet(token) {
  let fast = 0;
  for (let i = 0; i < 600 && fast < 3; i++) {
    const r = await request("GET", "/api/v2/movie-groups", { token });
    fast = r.ms < 40 ? fast + 1 : 0;
    if (fast === 0 && i % 10 === 0) log(`waiting for DB writes to drain (movie-groups ${r.ms.toFixed(0)} ms)`);
    await sleep(fast ? 200 : 2000);
  }
}

// ── Measurement ──────────────────────────────────────────────────────────────────────────
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function measure(name, urlPath, token, extraHeaders) {
  const headers = typeof extraHeaders === "function" ? undefined : extraHeaders;
  const first = await request("GET", urlPath, { token, headers });
  // Unknown /api paths fall through to the SPA catch-all (index.html, 200) — treat as missing.
  if (first.status === 404 || String(first.headers["content-type"] ?? "").startsWith("text/html")) {
    return { name, path: urlPath, status: 404 };
  }
  const times = [];
  let last = first;
  for (let i = 0; i < RUNS; i++) {
    const h = typeof extraHeaders === "function" ? extraHeaders(first) : headers;
    last = await request("GET", urlPath, { token, headers: h });
    times.push(last.ms);
  }
  times.sort((a, b) => a - b);
  const mem = memOf(serverProc.pid);
  const body = json(last);
  return {
    name, path: urlPath, status: last.status,
    firstMs: first.ms, p50: pct(times, 50), p95: pct(times, 95),
    wireBytes: last.wireBytes, rawBytes: last.rawBytes,
    // Hash of the first response body, to diff before/after outputs (live stream tokens make
    // /channels differ run to run; everything else is deterministic for the same DB).
    sha1: crypto.createHash("sha1").update(first.raw).digest("hex").slice(0, 12),
    items: Array.isArray(body) ? body.length : body?.data ? (Array.isArray(body.data) ? body.data.length : Object.keys(body.data).length) : undefined,
    total: body?.total_items,
    ...mem,
  };
}

// ── --verify: correctness checks (run against before and after code; outputs must agree) ──
async function verify(token) {
  const ok = (cond, msg) => log(`${cond ? "VERIFY OK  " : "VERIFY FAIL"} ${msg}`);
  // 1. /epg/window == brute force over /epg (programmes with stop > from && start < to, by start).
  const win = await request("GET", "/api/v2/epg/window?hours=6", { token });
  if (win.status === 200 && !String(win.headers["content-type"]).startsWith("text/html")) {
    const w = json(win);
    const full = json(await request("GET", "/api/v2/epg", { token }));
    const expect = {};
    for (const [id, list] of Object.entries(full.data)) {
      const sel = list
        .filter((p) => Number(p.stop_timestamp) > w.windowStart && Number(p.start_timestamp) < w.windowEnd)
        .sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp));
      if (sel.length) expect[id] = sel;
    }
    const same = JSON.stringify(expect) === JSON.stringify(w.data);
    const progs = Object.values(w.data).reduce((a, l) => a + l.length, 0);
    ok(same, `epg/window: ${Object.keys(w.data).length} channels, ${progs} programmes match a brute-force filter of /epg`);
    const ids = Object.keys(full.data).slice(0, 3);
    const sub = json(await request("GET", `/api/v2/epg/window?hours=6&ids=${ids.join(",")}`, { token }));
    ok(JSON.stringify(Object.keys(sub.data)) === JSON.stringify(ids.filter((i) => expect[i])), `epg/window ids= filter returns only ${ids.join(",")}`);
    ok(full.timestamp === w.timestamp, "epg/window timestamp equals /epg timestamp");
  }
  // 2. Overrides reach the "*" union: hide, rename, unhide (search bypasses ContentCache).
  const s0 = json(await request("GET", "/api/v2/movies?category=*&search=night", { token }));
  const victim = s0.data[0];
  const page1 = async () => {
    await request("DELETE", "/api/v2/clear-content-cache", { token });
    return json(await request("GET", "/api/v2/movies?category=*&page=1", { token }));
  };
  const p0 = await page1();
  await request("PUT", `/api/admin/items/movie/${victim.id}`, { token, body: { hidden: true } });
  const s1 = json(await request("GET", "/api/v2/movies?category=*&search=night", { token }));
  const p1 = await page1();
  ok(s1.total_items === s0.total_items - 1 && !s1.data.some((m) => m.id === victim.id), `hide ${victim.id}: search total ${s0.total_items} -> ${s1.total_items}`);
  ok(p1.total_items === p0.total_items - 1, `hide: "*" total ${p0.total_items} -> ${p1.total_items}`);
  await request("PUT", `/api/admin/items/movie/${victim.id}`, { token, body: { display_name: "Renamed By Bench" } });
  const s2 = json(await request("GET", "/api/v2/movies?category=*&search=night", { token }));
  ok(s2.data.some((m) => m.id === victim.id && m.name === "Renamed By Bench"), "rename shows in search results");
  await request("DELETE", `/api/admin/items/movie/${victim.id}`, { token });
  const p3 = await page1();
  ok(p3.total_items === p0.total_items && JSON.stringify(p3.data) === JSON.stringify(p0.data), "override removed: page 1 identical to the start");
}

const fmtB = (n) => (n == null ? "" : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtMs = (n) => (n == null ? "" : n >= 100 ? n.toFixed(0) : n.toFixed(1));

async function main() {
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const fresh = !!args.fresh || !fs.existsSync(DB_PATH);
  if (fresh) {
    for (const f of fs.readdirSync(BENCH_DIR)) if (f.startsWith("bench.db")) fs.rmSync(path.join(BENCH_DIR, f));
    fs.writeFileSync(ANCHOR_FILE, JSON.stringify({ anchor: Math.floor(Date.now() / 3600000) * 3600 }));
  }
  const { anchor } = JSON.parse(fs.readFileSync(ANCHOR_FILE, "utf8"));
  if (Date.now() / 1000 - anchor > 20 * 3600) log("WARNING: bench EPG is >20 h old — rerun with --fresh for a full guide window");

  const mock = await startMock({ port: MOCK_PORT, anchorSec: anchor });
  log(`mock upstream on :${MOCK_PORT}`);
  startServer();
  const cleanup = () => { stopServer(); mock.close(); };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  try {
    await waitForServer();
    log(`server up on :${PORT} (pid ${serverProc.pid}) — idle ${memOf(serverProc.pid).rssMB.toFixed(0)} MB`);
    const login = await request("POST", "/api/auth/admin", { body: { password: ADMIN_PASSWORD } });
    const token = json(login)?.token;
    if (!token) throw new Error(`admin login failed: ${login.status} ${login.raw}`);

    const tSetup = Date.now();
    if (fresh) await setup(token, mock);
    else await waitStartupWarm();
    await waitQuiet(token);
    const setupSec = fresh ? Math.round((Date.now() - tSetup) / 1000) : null;
    if (fresh) log(`setup incl. DB write drain: ${setupSec} s`);
    await request("DELETE", "/api/v2/clear-content-cache", { token });
    const idle = memOf(serverProc.pid);
    log(`idle after warm: RSS ${idle.rssMB.toFixed(0)} MB (peak so far ${idle.peakMB.toFixed(0)} MB)`);

    const oneCat = mock.catalog.vodCategories[0].category_id; // the largest (skewed distribution)
    const cases = [
      ["epg (full)", "/api/v2/epg"],
      ["epg/window 6h", "/api/v2/epg/window?hours=6"],
      ["epg/window 6h (304)", "/api/v2/epg/window?hours=6", (first) => ({ "If-None-Match": first.headers.etag ?? "" })],
      ["epg/window 6h ids=50", `/api/v2/epg/window?hours=6&ids=${Array.from({ length: 50 }, (_, i) => i * 200 + 1).join(",")}`],
      ["channels", "/api/v2/channels"],
      ["groups", "/api/v2/groups"],
      ["movies * p1", "/api/v2/movies?category=*&page=1"],
      ["movies * p50", "/api/v2/movies?category=*&page=50"],
      [`movies cat p1`, `/api/v2/movies?category=${oneCat}&page=1`],
      ["movies * search", "/api/v2/movies?category=*&search=night"],
      ["movies * search (2 words)", "/api/v2/movies?category=*&search=dark%20king"],
      ["movie open via Discover (* + movieId)", `/api/v2/movies?category=*&movieId=${[...mock.catalog.vodByCat.values()].at(-1)[0].stream_id}`],
      ["series * p1", "/api/v2/series?category=*&page=1"],
      ["series * search", "/api/v2/series?category=*&search=storm"],
      ["discover browse", "/api/v2/discover/browse?type=movie&page=1"],
    ];
    const results = [];
    for (const [name, p, h] of cases) {
      const r = await measure(name, p, token, h);
      results.push(r);
      log(r.status === 404 ? `${name}: 404 (not implemented)` :
        `${name}: first ${fmtMs(r.firstMs)} ms, p50 ${fmtMs(r.p50)} ms, p95 ${fmtMs(r.p95)} ms, ${fmtB(r.wireBytes)} wire / ${fmtB(r.rawBytes)} raw, RSS ${r.rssMB.toFixed(0)} MB`);
    }
    if (args.verify) await verify(token);
    const mem = memOf(serverProc.pid);
    const out = { label: LABEL, at: new Date().toISOString(), runs: RUNS, setupSec, idleRssMB: idle.rssMB, peakMB: mem.peakMB, finalRssMB: mem.rssMB, results };
    fs.writeFileSync(path.join(BENCH_DIR, `results-${LABEL}.json`), JSON.stringify(out, null, 2));

    console.log(`\n### ${LABEL} (N=${RUNS} warm runs; first = first request after server start / cache clear)\n`);
    console.log("| endpoint | first ms | p50 ms | p95 ms | gzip | raw | RSS after |");
    console.log("|---|---:|---:|---:|---:|---:|---:|");
    for (const r of results) {
      if (r.status === 404) { console.log(`| ${r.name} | — | — | — | — | — | (404) |`); continue; }
      console.log(`| ${r.name} | ${fmtMs(r.firstMs)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtB(r.wireBytes)} | ${fmtB(r.rawBytes)} | ${r.rssMB.toFixed(0)} MB |`);
    }
    console.log(`\nidle after warm ${idle.rssMB.toFixed(0)} MB, peak working set ${mem.peakMB.toFixed(0)} MB, final ${mem.rssMB.toFixed(0)} MB${setupSec ? `, setup ${setupSec} s` : ""}`);
    console.log("bodies: " + results.filter((r) => r.sha1).map((r) => `${r.name}=${r.sha1}`).join(" "));
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
