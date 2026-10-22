import { AsyncLocalStorage } from "async_hooks";
import axios from "axios";
import { setting } from "@/config/settings";
import { logger } from "@/infra/logger";

// Background portal work (the guide download, catalog warm, catch-up scan) goes through one
// queue per portal: one request at a time with a pause between, so a first setup on a big portal
// trickles in over hours instead of thousands of requests in minutes. A 429 ("too many requests")
// pauses that portal's queue (the portal's Retry-After when it sends one, else 1 min doubling to
// 30 min) and widens its pause; it narrows again while the portal answers. Another portal (after a
// profile switch) has its own queue and is not slowed. What a person is waiting on (a play link, a
// page) never queues here, but a 429 on it pauses that portal's background queue too.
// TMDB, OMDb, sports and image requests do not come through here at all.

const background = new AsyncLocalStorage<true>();

/** Runs fn with every portal request it makes (however deep) going through the background queue. */
export const inBackground = <T>(fn: () => Promise<T>): Promise<T> => background.run(true, fn);
const isBackground = () => background.getStore() === true;

const BASE_GAP = () => setting<number>("portalBackgroundGapMs");
const MAX_GAP_MS = 60_000;
const FIRST_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const NARROW_EVERY = 50;
// A background request refused with 429 is sent again after the pause, up to this many times.
const BACKGROUND_TRIES = 6;

interface Pace {
  widened: number;
  pausedUntil: number;
  strikes: number;
  okStreak: number;
  lastDoneAt: number;
  queueTail: Promise<void>;
}

// Keyed by the portal's address; never shown or logged (it is the provider's URL).
const paces = new Map<string, Pace>();
function paceOf(portal: string): Pace {
  let pace = paces.get(portal);
  if (!pace) {
    pace = { widened: 0, pausedUntil: 0, strikes: 0, okStreak: 0, lastDoneAt: 0, queueTail: Promise.resolve() };
    paces.set(portal, pace);
  }
  return pace;
}

const gap = (pace: Pace) => Math.max(BASE_GAP(), pace.widened);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function takeTurn(pace: Pace): Promise<() => void> {
  const before = pace.queueTail;
  let release!: () => void;
  pace.queueTail = new Promise<void>((r) => (release = r));
  await before;
  for (;;) {
    const wait = Math.max(pace.pausedUntil, pace.lastDoneAt + gap(pace)) - Date.now();
    if (wait <= 0) return release;
    // Re-checked at least every minute: a lowered setting or a new pause applies on the way.
    await sleep(Math.min(wait, 60_000));
  }
}

function retryAfterMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** True when error is the portal's 429; also starts (or extends) that portal's background pause. */
function noteRateLimit(pace: Pace, error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return false;
  const now = Date.now();
  pace.okStreak = 0;
  if (now < pace.pausedUntil) return true; // the same burst: already paused
  const asked = retryAfterMs(error.response.headers?.["retry-after"]);
  const pause = Math.min(MAX_PAUSE_MS, asked ?? FIRST_PAUSE_MS * 2 ** pace.strikes);
  pace.strikes++;
  pace.widened = Math.min(MAX_GAP_MS, Math.max(1000, gap(pace) * 2));
  pace.pausedUntil = now + pause;
  logger.warn(
    `[PortalPace] The portal says too many requests: background downloads pause ${Math.round(pause / 1000)} s, then one request every ${(gap(pace) / 1000).toFixed(1)} s`,
  );
  return true;
}

function noteSuccess(pace: Pace) {
  if (++pace.okStreak < NARROW_EVERY || pace.widened === 0) return;
  pace.okStreak = 0;
  pace.widened = Math.floor(pace.widened * 0.75);
  if (pace.widened <= BASE_GAP()) {
    pace.widened = 0;
    pace.strikes = 0;
    logger.info(`[PortalPace] Back to one background request every ${(gap(pace) / 1000).toFixed(1)} s`);
  }
}

/**
 * Sends one request to the portal at `portal` (its base address). send(background) gets true
 * for queued work, which should not do its own 429 retries (this waits out the pause and sends
 * it again instead).
 */
export async function pacedRequest<T>(portal: string, send: (background: boolean) => Promise<T>): Promise<T> {
  const pace = paceOf(portal);
  if (!isBackground()) {
    try {
      return await send(false);
    } catch (error) {
      noteRateLimit(pace, error);
      throw error;
    }
  }
  for (let attempt = 1; ; attempt++) {
    const release = await takeTurn(pace);
    try {
      const out = await send(true);
      noteSuccess(pace);
      return out;
    } catch (error) {
      if (!noteRateLimit(pace, error) || attempt >= BACKGROUND_TRIES) throw error;
    } finally {
      pace.lastDoneAt = Date.now();
      release();
    }
  }
}

/** For the admin overview (no addresses) and tests: one entry per portal used since start. */
export function portalPaceState() {
  return [...paces.values()].map((pace) => ({
    gapMs: gap(pace),
    pausedForMs: Math.max(0, pace.pausedUntil - Date.now()),
    strikes: pace.strikes,
  }));
}

export function resetPortalPaceForTests() {
  paces.clear();
}
