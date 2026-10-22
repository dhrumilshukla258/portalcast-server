import { AsyncLocalStorage } from "async_hooks";
import axios from "axios";
import { setting } from "@/config/settings";
import { logger } from "@/infra/logger";

// Background portal work (the guide download, catalog warm, catch-up scan) goes through one
// queue: one request at a time with a pause between, so a first setup on a big portal trickles
// in over hours instead of thousands of requests in minutes. A 429 ("too many requests") pauses
// the whole queue (the portal's Retry-After when it sends one, else 1 min doubling to 30 min) and
// widens the pause; it narrows again while the portal answers. What a person is waiting on (a
// play link, a page) never queues here, but a 429 on it pauses the background queue too.

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

let widened = 0;
let pausedUntil = 0;
let strikes = 0;
let okStreak = 0;
let lastDoneAt = 0;
let queueTail: Promise<void> = Promise.resolve();

const gap = () => Math.max(BASE_GAP(), widened);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function takeTurn(): Promise<() => void> {
  const before = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((r) => (release = r));
  await before;
  for (;;) {
    const wait = Math.max(pausedUntil, lastDoneAt + gap()) - Date.now();
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

/** True when error is the portal's 429; also starts (or extends) the background pause. */
export function noteRateLimit(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return false;
  const now = Date.now();
  okStreak = 0;
  if (now < pausedUntil) return true; // the same burst: already paused
  const asked = retryAfterMs(error.response.headers?.["retry-after"]);
  const pause = Math.min(MAX_PAUSE_MS, asked ?? FIRST_PAUSE_MS * 2 ** strikes);
  strikes++;
  widened = Math.min(MAX_GAP_MS, Math.max(1000, gap() * 2));
  pausedUntil = now + pause;
  logger.warn(
    `[PortalPace] The portal says too many requests: background downloads pause ${Math.round(pause / 1000)} s, then one request every ${(gap() / 1000).toFixed(1)} s`,
  );
  return true;
}

function noteSuccess() {
  if (++okStreak < NARROW_EVERY || widened === 0) return;
  okStreak = 0;
  widened = Math.floor(widened * 0.75);
  if (widened <= BASE_GAP()) {
    widened = 0;
    strikes = 0;
    logger.info(`[PortalPace] Back to one background request every ${(gap() / 1000).toFixed(1)} s`);
  }
}

/**
 * Sends one portal request. send(background) gets true for queued work, which should not do its
 * own 429 retries (this waits out the pause and sends it again instead).
 */
export async function pacedRequest<T>(send: (background: boolean) => Promise<T>): Promise<T> {
  if (!isBackground()) {
    try {
      return await send(false);
    } catch (error) {
      noteRateLimit(error);
      throw error;
    }
  }
  for (let attempt = 1; ; attempt++) {
    const release = await takeTurn();
    try {
      const out = await send(true);
      noteSuccess();
      return out;
    } catch (error) {
      if (!noteRateLimit(error) || attempt >= BACKGROUND_TRIES) throw error;
    } finally {
      lastDoneAt = Date.now();
      release();
    }
  }
}

/** For the admin overview and tests. */
export function portalPaceState() {
  return { gapMs: gap(), pausedForMs: Math.max(0, pausedUntil - Date.now()), strikes };
}

export function resetPortalPaceForTests() {
  widened = 0;
  pausedUntil = 0;
  strikes = 0;
  okStreak = 0;
  lastDoneAt = 0;
  queueTail = Promise.resolve();
}
