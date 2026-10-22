// Sports schedule (plan Phase 6.7): fixtures from sporting-events.org's free JSON files (no key,
// no sign-up; "free for personal and commercial use", credit with a link: the Sports page shows
// "Schedule: sporting-events.org"). The server reads the leagues in the `sportsLeagues` setting
// into memory (no database table) and answers GET /api/v2/sports; clients never call the source.
//
// Fetching only starts once someone opens Sports, then runs hourly (the "sports" job) while it
// is in use (a request in the last 3 days). One file per league, 500 ms apart; a failed file
// keeps that league's previous games.
//
// Channel match is strict on purpose (the owner: loose live-TV matching would be "buggy and not
// good"). A game lists a channel only when the guide has a programme on it that is running 15
// minutes after kick-off and whose name holds BOTH team names as whole words ("Everton v Chelsea",
// "Live: Chelsea at Everton"); an event without teams needs its whole name ("United States Grand
// Prix"); highlights, replays, previews and the like never count. Without a kick-off time (the
// source has none, or "00:00", which it uses for "time not set") the programme must start on that
// UTC day. A miss shows the broadcasters the source lists instead. Answers carry channel ids only:
// clients take names and logos from their own channel list, so hidden and renamed channels follow
// the admin's overrides.

import axios from "axios";
import crypto from "crypto";
import { setting, onSettingChange } from "@/config/settings";
import { logger } from "@/infra/logger";
import { getEpgSnapshot, forEachProgramme, guideEnd, type Snapshot } from "@/content/epgServe";

const SOURCE = "https://sporting-events.org/";
const DATA_BASE = "https://sporting-events.org/data/";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_LEAGUES = 20;
const FETCH_GAP_MS = 500;
const MAX_BYTES = 5 * 2 ** 20;
const MAX_EVENTS = 3000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Games kept: from a day ago to 30 days ahead. */
const KEEP_PAST_MS = DAY_MS;
const KEEP_AHEAD_MS = 30 * DAY_MS;
/** The job fetches only while Sports is in use. */
const IN_USE_MS = 3 * DAY_MS;
/** How long the first request waits for the first fetch before answering with what there is. */
const FIRST_WAIT_MS = 8000;
const MAX_CHANNELS = 6;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 14;

export interface Game {
  id: string;
  league: string;
  competition: string;
  sport: string;
  /** UTC date of the game, "2026-10-23". */
  date: string;
  /** Kick-off, ms since the epoch; null when the source gives no time. */
  start: number | null;
  title: string;
  home: string;
  away: string;
  venue: string;
  status: string;
  broadcast: string[];
  url: string;
}

export interface League {
  slug: string;
  competition: string;
  sport: string;
  page: string;
  games: Game[];
}

/** League slug -> sport, first match wins (golf and darts before the "league"/"cup" catch-all). */
const SPORT_OF: [RegExp, string][] = [
  [/cricket|ipl|ashes|champions-trophy/, "Cricket"],
  [/formula-1|motogp|nascar|indycar|wrc|le-mans|motorsport/, "Motorsport"],
  [/golf|masters|pga|open-championship|ryder-cup/, "Golf"],
  [/tennis|wimbledon|french-open|australian-open|atp|davis-cup/, "Tennis"],
  [/darts|snooker/, "Darts and snooker"],
  [/rugby|six-nations|nrl/, "Rugby"],
  [/nba|basketball|march-madness/, "Basketball"],
  [/nfl|american-football|college-football|super-bowl/, "American football"],
  [/nhl|ice-hockey|stanley-cup/, "Ice hockey"],
  [/mlb|baseball|world-series/, "Baseball"],
  [/mma|boxing|fight/, "Combat sports"],
  [/football|league|liga|serie-a|bundesliga|ligue|cup|copa/, "Football"],
];
/** Roughly how long a game runs, for the "Live" badge. */
const LENGTH_MS: Record<string, number> = {
  Football: 2 * HOUR_MS, Basketball: 2.5 * HOUR_MS, "American football": 3.5 * HOUR_MS, "Ice hockey": 2.5 * HOUR_MS,
  Baseball: 3 * HOUR_MS, Rugby: 2 * HOUR_MS, Motorsport: 2 * HOUR_MS, Cricket: 8 * HOUR_MS, Tennis: 3 * HOUR_MS,
};

export function sportOf(slug: string, competition: string): string {
  for (const [re, sport] of SPORT_OF) if (re.test(slug)) return sport;
  return competition || slug;
}

const clip = (v: unknown, n = 160) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const dayStartMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const sortKey = (g: Game) => g.start ?? dayStartMs(g.date);

/** One league file -> its games in the keep window. Defensive: the file comes from outside. */
export function parseLeague(slug: string, json: any, now = Date.now()): League {
  const competition = clip(json?.competition, 80) || slug;
  const sport = sportOf(slug, competition);
  const page = `${DATA_BASE}${slug}/`;
  const games: Game[] = [];
  const events: any[] = Array.isArray(json?.events) ? json.events.slice(0, MAX_EVENTS) : [];
  for (const e of events) {
    const date = clip(e?.date_utc, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const dayMs = dayStartMs(date);
    if (!Number.isFinite(dayMs)) continue;
    const time = clip(e?.time_utc, 5);
    const start = /^\d{2}:\d{2}$/.test(time) && time !== "00:00" ? Date.parse(`${date}T${time}:00Z`) : NaN;
    const at = Number.isFinite(start) ? start : dayMs;
    if (at + DAY_MS < now - KEEP_PAST_MS || at > now + KEEP_AHEAD_MS) continue;
    const title = clip(e?.fixture);
    if (!title) continue;
    const url = clip(e?.url, 300);
    const status = clip(e?.status, 20).toLowerCase();
    games.push({
      id: crypto.createHash("sha1").update(`${slug}|${e?.match}|${date}|${title}`).digest("base64url").slice(0, 12),
      league: slug,
      competition,
      sport,
      date,
      start: Number.isFinite(start) ? start : null,
      title,
      home: clip(e?.home_team, 80),
      away: clip(e?.away_team, 80),
      venue: [clip(e?.city, 60), clip(e?.country, 60)].filter(Boolean).join(", "),
      status: /^[a-z ]+$/.test(status) ? status : "",
      broadcast: clip(e?.broadcast, 300).split(",").map((b) => b.trim()).filter(Boolean).slice(0, 6),
      url: url.startsWith(SOURCE) ? url : page,
    });
  }
  games.sort((a, b) => sortKey(a) - sortKey(b));
  return { slug, competition, sport, page, games };
}

// ---- Strict guide match -------------------------------------------------------------------

/** Lowercase words without accents or punctuation, padded with spaces for whole-word tests. */
export function norm(s: string): string {
  const words = s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words ? ` ${words} ` : "";
}
const CLUB_WORDS = /^(?:fc|afc|cf|sc|ac) | (?:fc|afc|cf|sc)$/g;
/** "Everton FC" -> " everton "; empty when under 3 letters (too short to be safe). */
function teamNeedle(team: string): string {
  const n = norm(team).trim().replace(CLUB_WORDS, "").trim();
  return n.length >= 3 ? ` ${n} ` : "";
}
// "HL": highlights, as in "UCL HL 26/27: Lille v Galatasaray" (seen in the owner's guide).
const NOT_LIVE = / (?:highlights?|hl|replay|repeat|preview|review|rewind|classics?|magazine|reaction|recap|best of|goals|countdown|build up|extra) /;

/** What a programme name must hold for `g`, or null when the game cannot be matched safely. */
export function needlesOf(g: Pick<Game, "home" | "away" | "title">): string[] | null {
  if (g.home && g.away) {
    const a = teamNeedle(g.home), b = teamNeedle(g.away);
    return a && b && a !== b ? [a, b] : null;
  }
  // No teams: the whole event name ("the ashes 1st test"), at least two words, so a lone
  // "Tennis" never matches.
  const t = norm(g.title);
  return t && t.trim().split(" ").length >= 2 ? [t] : null;
}

/** A programme name made ready for [needlesOf]'s needles; "" when it is not a live showing. */
export function liveName(programmeName: string): string {
  const p = norm(programmeName);
  return p && !NOT_LIVE.test(p) ? p : "";
}

export function programmeMatches(programmeName: string, needles: string[]): boolean {
  const p = liveName(programmeName);
  return !!p && needles.every((n) => p.includes(n));
}

/** Unix seconds [from, to) where a matching programme must be running (or, date only, start). */
function windowOf(g: Game): { from: number; to: number; startsInside: boolean } {
  if (g.start !== null) {
    const t = Math.floor(g.start / 1000) + 15 * 60;
    return { from: t, to: t + 1, startsInside: false };
  }
  const day = Math.floor(dayStartMs(g.date) / 1000);
  return { from: day, to: day + 86400, startsInside: true };
}

export interface GameMatch { channelId: string; programme: string }

/**
 * Channels whose guide shows each game, by game id. One scan of the guide per distinct window
 * (games sharing a kick-off share it); games after the guide's end are skipped.
 */
async function matchGames(snap: Snapshot, games: Game[]): Promise<Map<string, GameMatch[]>> {
  const out = new Map<string, GameMatch[]>();
  const end = guideEnd(snap);
  const nowSec = Math.floor(Date.now() / 1000);
  const byWindow = new Map<string, { w: ReturnType<typeof windowOf>; items: { g: Game; needles: string[] }[] }>();
  for (const g of games) {
    const needles = needlesOf(g);
    if (!needles) continue;
    const w = windowOf(g);
    if (w.from >= end || w.to <= nowSec - 6 * 3600) continue;
    const key = `${w.from}:${w.to}`;
    let entry = byWindow.get(key);
    if (!entry) byWindow.set(key, (entry = { w, items: [] }));
    entry.items.push({ g, needles });
  }
  for (const { w, items } of byWindow.values()) {
    await forEachProgramme(snap, w.from, w.to, (channelId, name, start) => {
      if (w.startsInside && (start < w.from || start >= w.to)) return;
      const p = liveName(name);
      if (!p) return;
      for (const { g, needles } of items) {
        if (!needles.every((n) => p.includes(n))) continue;
        let list = out.get(g.id);
        if (!list) out.set(g.id, (list = []));
        if (list.length < MAX_CHANNELS && !list.some((m) => m.channelId === channelId)) {
          list.push({ channelId, programme: name.slice(0, 160) });
        }
      }
    });
  }
  return out;
}

// ---- Store and refresh -------------------------------------------------------------------

const leagues = new Map<string, League>();
let dataVersion = "";
let updatedAt = 0;
let lastRequest = 0;
let loading: Promise<string> | null = null;
let settingsChanged = false;
let matchCache: { key: string; result: Promise<Map<string, GameMatch[]>> } | null = null;

onSettingChange((key) => { if (key === "sportsLeagues") settingsChanged = true; });

/** The configured league slugs: lowercase, valid, unique, at most 20. */
export function configuredLeagues(): string[] {
  const raw = setting<string[]>("sportsLeagues") ?? [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (seen.size >= MAX_LEAGUES) break;
    const slug = String(s).trim().toLowerCase();
    if (SLUG.test(slug)) seen.add(slug);
  }
  return [...seen];
}

async function fetchLeague(slug: string): Promise<League> {
  const { data } = await axios.get(`${DATA_BASE}${slug}.json`, {
    timeout: 15000,
    maxContentLength: MAX_BYTES,
    maxRedirects: 2,
    responseType: "json",
    headers: { Accept: "application/json" },
  });
  if (!data || typeof data !== "object" || !Array.isArray((data as any).events)) throw new Error("not a fixtures file");
  return parseLeague(slug, data);
}

/** Fetch every configured league (one at a time, 500 ms apart). Returns a one-line summary. */
async function load(): Promise<string> {
  const slugs = configuredLeagues();
  settingsChanged = false;
  const failed: string[] = [];
  for (let i = 0; i < slugs.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    try {
      leagues.set(slugs[i], await fetchLeague(slugs[i]));
    } catch (e: any) {
      failed.push(slugs[i]);
      logger.warn(`[sports] ${slugs[i]}: ${e?.response?.status ?? e?.message ?? e}`);
    }
  }
  for (const slug of [...leagues.keys()]) if (!slugs.includes(slug)) leagues.delete(slug);
  // Re-match only when the games changed, not on every hourly fetch.
  const all = [...leagues.values()].flatMap((l) => l.games);
  const version = crypto.createHash("sha1").update(JSON.stringify(all)).digest("base64url");
  if (version !== dataVersion) { dataVersion = version; matchCache = null; }
  updatedAt = Date.now();
  return `${leagues.size} leagues, ${all.length} games` + (failed.length ? ` (failed: ${failed.join(", ")})` : "");
}

function loadOnce(): Promise<string> {
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

/** The hourly job: fetches only while Sports is in use. */
export async function refreshSports(): Promise<string> {
  if (!lastRequest || Date.now() - lastRequest > IN_USE_MS) return "skipped (Sports not opened lately)";
  return loadOnce();
}

async function matchesFor(games: Game[]): Promise<{ matches: Map<string, GameMatch[]>; guide: boolean }> {
  const snap = await getEpgSnapshot().catch(() => null);
  if (!snap) return { matches: new Map(), guide: false };
  // Per hour too: games move into the guide's range as time passes.
  const key = `${snap.rowKey}:${dataVersion}:${Math.floor(Date.now() / HOUR_MS)}`;
  if (matchCache?.key !== key) {
    const t0 = Date.now();
    const result = matchGames(snap, games).then((m) => {
      logger.info(`[sports] guide match: ${m.size} of ${games.length} games on a channel, ${Date.now() - t0} ms`);
      return m;
    });
    result.catch(() => { if (matchCache?.key === key) matchCache = null; });
    matchCache = { key, result };
  }
  return { matches: await matchCache.result, guide: true };
}

/** GET /api/v2/sports: games from 6 hours ago to `days` ahead (not finished), with channels. */
export async function sportsAnswer(days: number) {
  lastRequest = Date.now();
  if (updatedAt === 0 || settingsChanged) {
    await Promise.race([loadOnce().catch(() => ""), new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
  }
  const now = Date.now();
  const from = now - 6 * HOUR_MS;
  const to = now + days * DAY_MS;
  const slugs = configuredLeagues();
  const all = slugs.flatMap((s) => leagues.get(s)?.games ?? []);
  const games = all.filter((g) => {
    if (g.status === "completed" || g.status === "finished") return false;
    // A date-only game stays listed for its whole UTC day.
    return g.start !== null ? g.start >= from && g.start < to : dayStartMs(g.date) + DAY_MS > now && dayStartMs(g.date) < to;
  });
  const { matches, guide } = await matchesFor(all);
  return {
    source: { name: "sporting-events.org", url: SOURCE },
    updatedAt: updatedAt || null,
    loading: updatedAt === 0,
    guide,
    leagues: slugs.filter((s) => leagues.has(s)).map((s) => {
      const l = leagues.get(s)!;
      return { id: l.slug, name: l.competition, sport: l.sport, url: l.page };
    }),
    games: games
      .sort((a, b) => sortKey(a) - sortKey(b))
      .map((g) => ({
        ...g,
        live: g.start !== null && now >= g.start && now < g.start + (LENGTH_MS[g.sport] ?? 3 * HOUR_MS),
        channels: matches.get(g.id) ?? [],
      })),
  };
}

export function parseDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_DAYS) : DEFAULT_DAYS;
}
