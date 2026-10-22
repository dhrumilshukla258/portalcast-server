// Serving side of the EPG: `/api/v2/epg` (whole guide) and `/api/v2/epg/window` (only the
// programmes overlapping the next few hours).
//
// Why this exists: the stored guide is one gzip'd JSON blob per profile (EpgCache.data, see
// src/infra/storage.ts). On the owner's portal that is 549k programmes / 50 MB of JSON. The old
// handler read it, gunzipped it, JSON.parse'd it, and hapi then re-stringified and re-gzipped
// all 50 MB on EVERY request (several seconds of CPU and a few hundred MB of garbage each time),
// although clients only ever show now/next.
//
// Design — one immutable *snapshot* per stored guide (keyed by the EpgCache row id +
// timestamp, checked with a tiny metadata-only query per request):
//   - fullGz: the complete `{timestamp,data}` response, gzipped once (async, off the event
//     loop). /api/v2/epg becomes a buffer send: O(1) per request.
//   - A columnar programme store for windows:
//       buf          one Buffer holding every not-yet-ended programme's original JSON, laid out
//                    per channel, sorted by start, comma-separated — so a run of consecutive
//                    programmes is a single zero-copy `subarray`
//       start/stop   Uint32Array unix seconds per programme
//       maxStop      Uint32Array prefix-max of `stop` within each channel. It is monotone even
//                    when a portal sends overlapping programmes, so "first programme that may
//                    still be running at t" is a binary search.
//       byteStart/byteEnd  Uint32Array byte range of each programme inside `buf`
//       chanOff      Uint32Array(C+1) programme index range per channel
//     Memory: ~the JSON size of the remaining programmes (off-heap) + 5 x 4 bytes per programme,
//     instead of ~549k JS objects.
//   - Window query [from, to): per channel, lo = first i with maxStop[i] > from (binary search),
//     hi = first i with start[i] >= to (binary search), then emit i in [lo, hi) with
//     stop[i] > from. O(C log P + K) for C channels, P programmes per channel, K emitted.
//   - Windows are hour-quantised: from = start of the current hour, to = from + (hours+1) h, so
//     a response stays valid (covers now..now+hours) for the whole hour and can be built once,
//     gzipped once and served as a buffer with a stable ETag (clients refreshing every 30 min
//     get 304s). The 6 h window is prebuilt with the snapshot and again at each hour boundary.
import zlib from "zlib";
import { promisify } from "util";
import crypto from "crypto";
import { EpgCache } from "@/models/EpgCache";
import { ConfigProfile } from "@/models/ConfigProfile";
import { logger } from "@/infra/logger";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Same staleness rule as getEpgCache() in content/epg.ts: older guides are not served. */
const STALE_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_HOURS = 6;
export const MAX_WINDOW_HOURS = 24;
const MAX_IDS = 5000;
const HOUR = 3600;

interface Columns {
  channelIds: string[];
  keyPrefix: Buffer[];   // `"<id>":[` per channel
  chanOff: Uint32Array;  // C+1
  start: Uint32Array;
  stop: Uint32Array;
  maxStop: Uint32Array;
  byteStart: Uint32Array;
  byteEnd: Uint32Array;
  buf: Buffer;
}

export interface BuiltBody { gz: Buffer; etag: string; rawBytes: number }

export interface Snapshot {
  profileKey: string;
  rowKey: string;           // EpgCache id + timestamp: identifies the stored guide
  timestamp: Date;
  timestampJson: string;    // JSON.stringify(timestamp)
  full: BuiltBody;
  cols: Columns;
  windows: Map<string, Promise<BuiltBody>>; // `${hours}:${from}` for the current hour only
  windowsHour: number;
}

const snapshots = new Map<string, Snapshot>();
const building = new Map<string, Promise<Snapshot | null>>();
let hourTimer: NodeJS.Timeout | null = null;

const etagOf = (s: string) => `W/"${crypto.createHash("sha1").update(s).digest("base64url").slice(0, 22)}"`;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

async function activeProfileId(): Promise<number | undefined> {
  const p = await ConfigProfile.findOne({ where: { isActive: true }, attributes: ["id"] });
  return p?.id;
}

/** Metadata of the newest stored guide for a profile — never reads the (large) data column. */
async function latestRowMeta(profileId: number | undefined) {
  return EpgCache.findOne({
    where: profileId !== undefined ? { profileId } : {},
    order: [["timestamp", "DESC"]],
    attributes: ["id", "timestamp"],
    raw: true,
  }) as Promise<{ id: number; timestamp: Date | string } | null>;
}

const toSec = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : NaN;
};

/**
 * Columnar store of every programme that has not ended before `dropBefore` (it can never
 * appear in a window again, since windows only move forward). O(P log P) once per guide.
 */
async function buildColumns(data: Record<string, any[]>, dropBefore: number): Promise<Columns> {
  const channelIds = Object.keys(data);
  const C = channelIds.length;
  let P = 0;
  for (const id of channelIds) P += Array.isArray(data[id]) ? data[id].length : 0;

  const chanOff = new Uint32Array(C + 1);
  const start = new Uint32Array(P);
  const stop = new Uint32Array(P);
  const maxStop = new Uint32Array(P);
  const byteStart = new Uint32Array(P);
  const byteEnd = new Uint32Array(P);
  const keyPrefix: Buffer[] = new Array(C);
  const parts: string[] = [];
  const bufChunks: Buffer[] = [];
  let partsLen = 0;
  let bytePos = 0;
  let n = 0;

  for (let c = 0; c < C; c++) {
    chanOff[c] = n;
    const id = channelIds[c];
    keyPrefix[c] = Buffer.from(`${JSON.stringify(id)}:[`);
    const list = Array.isArray(data[id]) ? data[id] : [];
    // Keep programmes with usable timestamps that are still running or upcoming, by start.
    const keep: { s: number; e: number; p: any }[] = [];
    for (const p of list) {
      const s = toSec(p?.start_timestamp);
      const e = toSec(p?.stop_timestamp);
      if (Number.isNaN(s) || Number.isNaN(e) || e <= dropBefore) continue;
      keep.push({ s, e, p });
    }
    keep.sort((a, b) => a.s - b.s);
    let runMax = 0;
    for (let k = 0; k < keep.length; k++) {
      const json = (k > 0 ? "," : "") + JSON.stringify(keep[k].p);
      const sepBytes = k > 0 ? 1 : 0;
      const len = Buffer.byteLength(json);
      start[n] = keep[k].s;
      stop[n] = keep[k].e;
      runMax = Math.max(runMax, keep[k].e);
      maxStop[n] = runMax;
      byteStart[n] = bytePos + sepBytes; // excludes the leading comma
      byteEnd[n] = bytePos + len;
      bytePos += len;
      parts.push(json);
      partsLen += json.length;
      n++;
    }
    // Flush string parts into Buffers periodically so no single huge JS string is built.
    if (partsLen > 4 * 1024 * 1024) {
      bufChunks.push(Buffer.from(parts.join("")));
      parts.length = 0;
      partsLen = 0;
    }
    if (c % 500 === 499) await yieldLoop();
  }
  chanOff[C] = n;
  bufChunks.push(Buffer.from(parts.join("")));
  const buf = Buffer.concat(bufChunks);
  return {
    channelIds, keyPrefix, chanOff,
    start: start.slice(0, n), stop: stop.slice(0, n), maxStop: maxStop.slice(0, n),
    byteStart: byteStart.slice(0, n), byteEnd: byteEnd.slice(0, n), buf,
  };
}

/** First index i in [lo, hi) with arr[i] > x (arr ascending). */
function firstGreater(arr: Uint32Array, lo: number, hi: number, x: number): number {
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] > x) hi = mid; else lo = mid + 1; }
  return lo;
}
/** First index i in [lo, hi) with arr[i] >= x (arr ascending). */
function firstAtLeast(arr: Uint32Array, lo: number, hi: number, x: number): number {
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] >= x) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * Serialises `{timestamp, windowStart, windowEnd, data}` for programmes overlapping [from, to).
 * `only` restricts it to the given channel indices. Channels with nothing in range are omitted.
 */
function windowJson(snap: Snapshot, from: number, to: number, only?: number[]): Buffer {
  const { cols } = snap;
  const out: Buffer[] = [Buffer.from(`{"timestamp":${snap.timestampJson},"windowStart":${from},"windowEnd":${to},"data":{`)];
  const comma = Buffer.from(",");
  const close = Buffer.from("]");
  let first = true;
  const C = cols.channelIds.length;
  const count = only ? only.length : C;
  for (let j = 0; j < count; j++) {
    const c = only ? only[j] : j;
    const cLo = cols.chanOff[c], cHi = cols.chanOff[c + 1];
    if (cLo === cHi) continue;
    const lo = firstGreater(cols.maxStop, cLo, cHi, from);
    const hi = firstAtLeast(cols.start, lo, cHi, to);
    if (lo >= hi) continue;
    // Common case (no overlapping programmes): every i in [lo, hi) qualifies, so the whole run
    // is one contiguous slice of `buf`. Otherwise emit the qualifying programmes one by one.
    let contiguous = true;
    for (let i = lo; i < hi; i++) if (cols.stop[i] <= from) { contiguous = false; break; }
    const pieces: Buffer[] = [];
    if (contiguous) {
      pieces.push(cols.buf.subarray(cols.byteStart[lo], cols.byteEnd[hi - 1]));
    } else {
      for (let i = lo; i < hi; i++) {
        if (cols.stop[i] <= from) continue;
        if (pieces.length) pieces.push(comma);
        pieces.push(cols.buf.subarray(cols.byteStart[i], cols.byteEnd[i]));
      }
      if (pieces.length === 0) continue;
    }
    if (!first) out.push(comma);
    first = false;
    out.push(cols.keyPrefix[c], ...pieces, close);
  }
  out.push(Buffer.from("}}"));
  return Buffer.concat(out);
}

async function buildSnapshot(profileId: number | undefined, profileKey: string, rowKey: string): Promise<Snapshot | null> {
  const t0 = Date.now();
  const row = await EpgCache.findOne({
    where: profileId !== undefined ? { profileId } : {},
    order: [["timestamp", "DESC"]],
  });
  if (!row) return null;
  let text: string;
  try {
    text = (await gunzip(Buffer.from(row.data, "base64"))).toString("utf8");
  } catch {
    text = row.data; // legacy uncompressed rows (same fallback as readEpgCache)
  }
  const timestamp = new Date(row.timestamp);
  const timestampJson = JSON.stringify(timestamp);
  // The whole-guide response, byte-for-byte what `return cache` used to serialise.
  const fullRaw = Buffer.from(`{"timestamp":${timestampJson},"data":${text}}`);
  const fullGzP = gzip(fullRaw);
  const data = JSON.parse(text) as Record<string, any[]>;
  text = "";
  const nowSec = Math.floor(Date.now() / 1000);
  const cols = await buildColumns(data, nowSec - (nowSec % HOUR));
  const snap: Snapshot = {
    profileKey, rowKey, timestamp, timestampJson,
    full: { gz: await fullGzP, etag: etagOf(`full:${rowKey}`), rawBytes: fullRaw.length },
    cols, windows: new Map(), windowsHour: 0,
  };
  logger.info(
    `[EPG] snapshot built in ${Date.now() - t0} ms: ${cols.channelIds.length} channels, ` +
    `${cols.start.length} upcoming programmes (${(cols.buf.length / 2 ** 20).toFixed(1)} MB), ` +
    `full guide ${(fullRaw.length / 2 ** 20).toFixed(1)} MB -> ${(snap.full.gz.length / 2 ** 20).toFixed(1)} MB gzip`,
  );
  return snap;
}

/**
 * The snapshot for the active profile's current stored guide, or null when there is none or it
 * is older than 12 h. Cost per call: two small indexed queries; a rebuild happens only when the
 * stored guide changed (once per EPG refresh), shared by concurrent callers.
 */
export async function getEpgSnapshot(): Promise<Snapshot | null> {
  const profileId = await activeProfileId();
  const profileKey = String(profileId ?? "none");
  const meta = await latestRowMeta(profileId);
  if (!meta) { snapshots.delete(profileKey); return null; }
  const ts = new Date(meta.timestamp);
  if (Date.now() - ts.getTime() > STALE_MS) return null;
  const rowKey = `${profileKey}:${meta.id}:${ts.getTime()}`;
  const have = snapshots.get(profileKey);
  if (have && have.rowKey === rowKey) return have;

  const inflight = building.get(rowKey);
  if (inflight) return inflight;
  const p = buildSnapshot(profileId, profileKey, rowKey)
    .then((snap) => {
      if (snap) {
        snapshots.set(profileKey, snap);
        // Pre-build the default window so the first Live-tab visit is a buffer send.
        getWindow(snap, DEFAULT_WINDOW_HOURS).catch(() => {});
        scheduleHourlyPrebuild();
      }
      return snap;
    })
    .finally(() => building.delete(rowKey));
  building.set(rowKey, p);
  return p;
}

/** Hour-quantised [from, to) for `hours`; see the header comment. */
export function windowBounds(hours: number, nowMs = Date.now()): [number, number] {
  const now = Math.floor(nowMs / 1000);
  const from = now - (now % HOUR);
  return [from, from + (hours + 1) * HOUR];
}

/** Prebuilt, gzipped full-channel window for `hours` in the current hour (memoised per hour). */
export function getWindow(snap: Snapshot, hours: number): Promise<BuiltBody> {
  const [from, to] = windowBounds(hours);
  if (snap.windowsHour !== from) { snap.windows.clear(); snap.windowsHour = from; }
  const key = `${hours}:${from}`;
  let p = snap.windows.get(key);
  if (!p) {
    p = (async () => {
      const raw = windowJson(snap, from, to);
      return { gz: await gzip(raw), etag: etagOf(`win:${snap.rowKey}:${key}`), rawBytes: raw.length };
    })();
    p.catch(() => snap.windows.delete(key));
    snap.windows.set(key, p);
  }
  return p;
}

/** Window restricted to some channel ids — built per request (small), not cached. */
export function getWindowForIds(snap: Snapshot, hours: number, ids: string[]): { raw: Buffer; etag: string } {
  const [from, to] = windowBounds(hours);
  const want = new Set(ids.slice(0, MAX_IDS));
  const only: number[] = [];
  snap.cols.channelIds.forEach((id, c) => { if (want.has(id)) only.push(c); });
  const raw = windowJson(snap, from, to, only);
  const idsKey = crypto.createHash("sha1").update([...want].sort().join(",")).digest("hex");
  return { raw, etag: etagOf(`win:${snap.rowKey}:${hours}:${from}:${idsKey}`) };
}

/** Prebuild the default window shortly after each hour boundary for every live snapshot. */
function scheduleHourlyPrebuild(): void {
  if (hourTimer) return;
  const msToNextHour = HOUR * 1000 - (Date.now() % (HOUR * 1000)) + 1000;
  hourTimer = setTimeout(() => {
    hourTimer = null;
    for (const snap of snapshots.values()) getWindow(snap, DEFAULT_WINDOW_HOURS).catch(() => {});
    if (snapshots.size > 0) scheduleHourlyPrebuild();
  }, msToNextHour);
  hourTimer.unref();
}

/**
 * Calls `visit` for every programme on any channel that overlaps [from, to) (unix seconds), with
 * its channel id, name and times. Parses only the programmes in range (the Sports page's guide
 * match, content/sports.ts); yields to the event loop every 1000 channels.
 */
export async function forEachProgramme(
  snap: Snapshot, from: number, to: number,
  visit: (channelId: string, name: string, start: number, stop: number) => void,
): Promise<void> {
  const { cols } = snap;
  const C = cols.channelIds.length;
  for (let c = 0; c < C; c++) {
    const cLo = cols.chanOff[c], cHi = cols.chanOff[c + 1];
    if (cLo !== cHi) {
      const lo = firstGreater(cols.maxStop, cLo, cHi, from);
      const hi = firstAtLeast(cols.start, lo, cHi, to);
      for (let i = lo; i < hi; i++) {
        if (cols.stop[i] <= from) continue;
        let name: unknown;
        try { name = JSON.parse(cols.buf.toString("utf8", cols.byteStart[i], cols.byteEnd[i]))?.name; } catch { continue; }
        if (typeof name === "string" && name) visit(cols.channelIds[c], name, cols.start[i], cols.stop[i]);
      }
    }
    if (c % 1000 === 999) await yieldLoop();
  }
}

/** The last programme end in the guide (unix seconds): games after it cannot match. */
export function guideEnd(snap: Snapshot): number {
  let end = 0;
  const { cols } = snap;
  for (let c = 0; c < cols.channelIds.length; c++) {
    const hi = cols.chanOff[c + 1];
    if (hi > cols.chanOff[c] && cols.maxStop[hi - 1] > end) end = cols.maxStop[hi - 1];
  }
  return end;
}

/** Called after a new guide is stored so the snapshot is rebuilt before the next client asks. */
export function primeEpgSnapshot(): void {
  getEpgSnapshot().catch((e) => logger.warn(`[EPG] snapshot prebuild failed: ${e}`));
}

/** True when the request's If-None-Match matches `etag` (weak comparison). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const want = strip(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || strip(t) === want);
}

export function parseWindowHours(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINDOW_HOURS;
  return Math.min(n, MAX_WINDOW_HOURS);
}
