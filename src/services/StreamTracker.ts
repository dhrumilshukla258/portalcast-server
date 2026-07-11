// Tracks "who is watching what right now" across the three proxy paths
// (generic proxy, live HLS, VOD transcode). HLS/live playback is fundamentally
// a stream of short-lived HTTP requests (playlist refresh every few seconds,
// one request per segment) rather than a single long connection, so there is
// no clean "stream start"/"stream end" event to hook. Instead each request
// "touches" a session keyed by (client IP + resource), refreshing a lastSeen
// timestamp; a session is considered active until it goes quiet for longer
// than a normal HLS refresh interval, at which point the sweep removes it.

export type StreamKind = "proxy" | "live" | "vod";
export type ContentKind = "live" | "movie" | "series";

export interface StreamMeta {
  kind?: ContentKind;
  label?: string;
  category?: string;
}

export interface StreamSession {
  key: string;
  type: StreamKind;
  ip: string;
  resource: string;
  user: string | null;
  kind: ContentKind | null;
  label: string | null;
  category: string | null;
  startedAt: number;
  lastSeen: number;
}

// How long a session can go quiet (no request) before it's considered ended.
// Needs to be generous enough to survive a player buffering ahead and pausing
// requests for a while, not just tuned to the fastest-case segment interval.
const IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 60_000;
const SWEEP_INTERVAL_MS = 10_000;

class StreamTracker {
  private sessions = new Map<string, StreamSession>();

  constructor() {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  private sweep() {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [key, session] of this.sessions.entries()) {
      if (session.lastSeen < cutoff) this.sessions.delete(key);
    }
  }

  // `user`/`meta`, when omitted, preserve whatever was already known for this
  // session — most requests for an in-progress stream (HLS segment fetches,
  // playlist refreshes) don't carry the full identity/metadata themselves,
  // only the request that kicked the stream off does. The resource key is
  // stable across those follow-up requests, so what was set on first touch
  // carries forward.
  touch(type: StreamKind, ip: string, resource: string, user?: string | null, meta?: StreamMeta): void {
    const key = `${type}:${ip}:${resource}`;
    const now = Date.now();
    const existing = this.sessions.get(key);
    this.sessions.set(key, {
      key,
      type,
      ip,
      resource,
      user: user ?? existing?.user ?? null,
      kind: meta?.kind ?? existing?.kind ?? null,
      label: meta?.label ?? existing?.label ?? null,
      category: meta?.category ?? existing?.category ?? null,
      startedAt: existing?.startedAt ?? now,
      lastSeen: now,
    });
  }

  list(): StreamSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => a.startedAt - b.startedAt);
  }

  count(): number {
    return this.sessions.size;
  }
}

export const streamTracker = new StreamTracker();
