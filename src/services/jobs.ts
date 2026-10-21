// One runner for background work (the architecture plan's "job runner").
//
// Jobs run one at a time, so background work never piles up on the NAS or the database.
// Nothing waits for viewers: every job is built to run alongside them (non-blocking file
// access, short write transactions, a gentler pace for disk-heavy steps while someone
// streams). Each job's last run, result and error are kept for Admin → Settings.
//
// New background work registers here. The older timers in server.ts (EPG refresh,
// catalog warm-up, enrichment) still run on their own and move here as they are touched.

import { logger } from "@/infra/logger";

export interface JobDef {
  name: string;
  label: string;
  /** Run once a day at this local hour (0-23)... */
  dailyAtHour?: number;
  /** ...or every N milliseconds. */
  everyMs?: number;
  /** Returns a one-line summary of what it did. */
  run: () => Promise<string | void>;
}

interface JobState {
  def: JobDef;
  running: boolean;
  queued: boolean;
  lastStart: number | null;
  lastEnd: number | null;
  lastResult: string | null;
  lastError: string | null;
  nextDue: number;
}

const TICK_MS = 60 * 1000;
const jobs = new Map<string, JobState>();
const queue: string[] = [];
let busy = false;
let timer: NodeJS.Timeout | null = null;

function nextDueFor(def: JobDef, from: number): number {
  if (def.everyMs) return from + def.everyMs;
  const hour = def.dailyAtHour ?? 4;
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function registerJob(def: JobDef): void {
  if (jobs.has(def.name)) throw new Error(`Job "${def.name}" registered twice`);
  jobs.set(def.name, {
    def, running: false, queued: false, lastStart: null, lastEnd: null, lastResult: null, lastError: null,
    nextDue: nextDueFor(def, Date.now()),
  });
}

function enqueue(name: string): boolean {
  const s = jobs.get(name);
  if (!s || s.running || s.queued) return false;
  s.queued = true;
  queue.push(name);
  void drain();
  return true;
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      const s = jobs.get(name)!;
      s.queued = false;
      s.running = true;
      s.lastStart = Date.now();
      try {
        const result = await s.def.run();
        s.lastResult = result ? String(result) : "done";
        s.lastError = null;
      } catch (e: any) {
        s.lastError = String(e?.message ?? e).slice(0, 300);
        logger.error(`[jobs] ${s.def.label} failed: ${s.lastError}`);
      } finally {
        s.running = false;
        s.lastEnd = Date.now();
        s.nextDue = nextDueFor(s.def, s.lastEnd);
      }
    }
  } finally {
    busy = false;
  }
}

function tick(): void {
  const now = Date.now();
  for (const [name, s] of jobs) {
    if (!s.running && !s.queued && s.nextDue <= now) enqueue(name);
  }
  void drain();
}

export function startJobs(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}

/** Admin "Run now". False when it is already running or queued. */
export function runJobNow(name: string): boolean {
  return enqueue(name);
}

export function listJobs() {
  return [...jobs.values()].map((s) => ({
    name: s.def.name,
    label: s.def.label,
    schedule: s.def.everyMs ? `every ${Math.round(s.def.everyMs / 60000)} min` : `daily at ${String(s.def.dailyAtHour ?? 4).padStart(2, "0")}:00`,
    running: s.running,
    queued: s.queued,
    lastStart: s.lastStart ? new Date(s.lastStart).toISOString() : null,
    lastEnd: s.lastEnd ? new Date(s.lastEnd).toISOString() : null,
    lastResult: s.lastResult,
    lastError: s.lastError,
    nextDue: new Date(s.nextDue).toISOString(),
  }));
}
