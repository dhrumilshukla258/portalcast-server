// New episodes of the series people watch (Home's "New episodes" row, content/homeThemes.ts).
// A series' date in the portal's lists does not move when episodes arrive (on Stalker portals it
// is when the series was added), so the series viewers watched in the last 30 days are read
// again, at most once a day each, through the background queue (services/portalPace.ts): a
// few requests per series, only for series someone is following.
//
// content_meta.providerEpisodeAt (unix seconds) is set when a series has new episodes:
//   - the portal's own date of its newest episode, when it gives one
//   - else the time this check first saw the episode list grow (checked daily: within a day)
// The first look at a series only records how many episodes it has (or uses the portal's
// dates): a series is never called new just because this server had not looked before.

import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { SystemConfig } from "@/models/SystemConfig";
import { readGenres } from "@/infra/storage";
import { xtreamCache, fetchSeriesInfo } from "@/services/xtreamCache";
import { inBackground } from "@/services/portalPace";
import { allViewerRows, viewersReady, progressType, catalogIdOf } from "@/content/viewers";
import { providerSeconds, notifyProviderDatesChanged } from "@/content/providerDates";
import { logger } from "@/infra/logger";

const DAY = 86_400_000;
const STATE_KEY = "episode_watch";
const WATCHED_WITHIN = 30 * DAY;
const RECHECK_AFTER = 20 * 3600_000;
const MAX_PER_RUN = 60;
const FORGET_AFTER = 60 * DAY;
/** A portal that is down or refusing: stop after this many failures in a row (jobs run one at a
 *  time, so a stuck run would hold the others); the next run carries on. */
const MAX_FAILURES_IN_A_ROW = 3;

interface SeriesState { n: number; at: number }

/**
 * A series history row's possible portal series ids, best first: the catalog id the app stored,
 * then meta.mediaId (the series on rows whose own mediaId is an episode's file), then mediaId.
 * The first one the portal lists as a series is used (checkWatchedSeriesNow).
 */
export function seriesCandidates(row: { mediaId: unknown; meta: unknown }): number[] {
  let meta: any = row.meta;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
  const out: number[] = [];
  const add = (v: unknown) => {
    const m = /^(?:series_)?(\d+)$/.exec(String(v ?? ""));
    if (m && !out.includes(Number(m[1]))) out.push(Number(m[1]));
  };
  const catalogId = catalogIdOf(row);
  if (catalogId?.startsWith("series_")) add(catalogId);
  add(meta?.mediaId);
  add(row.mediaId);
  return out;
}

/** Episodes in a stored series info, and the newest episode date the portal gave (seconds). */
export function episodeSummary(info: any): { n: number; newest: number } {
  let n = 0, newest = 0;
  for (const eps of Object.values(info?.episodes ?? {}) as any[][]) {
    if (!Array.isArray(eps)) continue;
    n += eps.length;
    for (const ep of eps) {
      const sec = providerSeconds(ep?.info?.releasedate);
      if (sec && sec > newest) newest = sec;
    }
  }
  return { n, newest };
}

/**
 * The date to store for a series (seconds), or null to leave it: [prev] is the last check
 * (none on the first look), [now] in ms.
 */
export function newEpisodesAt(prev: SeriesState | undefined, cur: { n: number; newest: number }, now: number): number | null {
  const grew = !!prev && cur.n > prev.n;
  if (cur.newest) {
    // The portal's date, unless it is older than the last check while the list grew (a
    // portal that keeps the season's date on every episode): then the check's own time.
    if (grew && cur.newest * 1000 < prev!.at - DAY) return Math.floor(now / 1000);
    return cur.newest;
  }
  return grew ? Math.floor(now / 1000) : null;
}

export function checkWatchedSeries(): Promise<string> {
  return inBackground(checkWatchedSeriesNow);
}

async function checkWatchedSeriesNow(): Promise<string> {
  await viewersReady();
  const now = Date.now();
  // The series history rows of the last 30 days, each with its possible series ids.
  const recent: { at: number; ids: number[] }[] = [];
  for (const v of allViewerRows()) {
    for (const r of v.rows) {
      const at = new Date(r.updatedAt).getTime();
      if (!(at >= now - WATCHED_WITHIN) || progressType(r) !== "series") continue;
      const ids = seriesCandidates(r);
      if (ids.length) recent.push({ at, ids });
    }
  }
  if (!recent.length) return "no series watched lately";

  // Which of them the current portal lists as series (a profile switch, a removed series or an
  // episode's file id is skipped); each row counts for its first listed id.
  const wanted = new Set(recent.flatMap((x) => x.ids));
  const listed = new Set<number>();
  for (const genre of await readGenres("series")) {
    if (!genre.id || genre.id === "*") continue;
    const list = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (Array.isArray(list)) for (const s of list) if (wanted.has(Number(s?.series_id))) listed.add(Number(s.series_id));
  }
  // The series watched lately (portal ids) and when, most recent first below.
  const lastWatched = new Map<number, number>();
  for (const { at, ids } of recent) {
    const id = ids.find((x) => listed.has(x));
    if (id !== undefined && at > (lastWatched.get(id) ?? 0)) lastWatched.set(id, at);
  }

  const row = await SystemConfig.findByPk(STATE_KEY);
  const state: Record<string, SeriesState> = row?.value && typeof row.value === "object" ? { ...row.value } : {};
  const due = [...lastWatched.keys()]
    .filter((id) => !(now - (state[id]?.at ?? 0) < RECHECK_AFTER))
    .sort((a, b) => lastWatched.get(b)! - lastWatched.get(a)!)
    .slice(0, MAX_PER_RUN);

  const found = new Map<string, number>(); // content id -> seconds
  let checked = 0, failed = 0, inARow = 0;
  for (const id of due) {
    if (inARow >= MAX_FAILURES_IN_A_ROW) break;
    try {
      const info = await fetchSeriesInfo(id);
      const cur = episodeSummary(info);
      if (!cur.n) continue; // nothing read: keep the last count
      const at = newEpisodesAt(state[id], cur, now);
      if (at) found.set(`series_${id}`, at);
      state[id] = { n: cur.n, at: now };
      checked++;
      inARow = 0;
    } catch (e: any) {
      failed++;
      inARow++;
      logger.warn(`[new-episodes] series ${id} not read: ${e?.message ?? e}`);
    }
  }
  for (const [id, s] of Object.entries(state)) if (now - s.at > FORGET_AFTER) delete state[id];
  await SystemConfig.upsert({ key: STATE_KEY, value: state });

  // Only dates that are newer than the stored ones are written.
  let changed = 0;
  if (found.size) {
    const ids = [...found.keys()];
    const stored = (await sequelize.query(`SELECT id, providerEpisodeAt FROM content_meta WHERE id IN (${ids.map(() => "?").join(",")})`, {
      replacements: ids,
      type: QueryTypes.SELECT,
    })) as any[];
    await sequelize.transaction(async (transaction) => {
      for (const r of stored) {
        const sec = found.get(String(r.id))!;
        if (sec > (Number(r.providerEpisodeAt) || 0)) {
          await sequelize.query("UPDATE content_meta SET providerEpisodeAt = ? WHERE id = ?", { replacements: [sec, r.id], transaction });
          changed++;
        }
      }
    });
  }
  if (changed) {
    logger.info(`[new-episodes] ${changed} series with new episodes (${checked} checked)`);
    notifyProviderDatesChanged();
  }
  return `${checked} series checked${failed ? `, ${failed} not read` : ""}, ${changed} with new episodes`;
}
