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
import { readChannels, readGenres } from "@/infra/storage";
import { ConfigProfile } from "@/models/ConfigProfile";

async function activeProfileIdForSports(): Promise<number | undefined> {
  const p = await ConfigProfile.findOne({ where: { isActive: true }, attributes: ["id"] });
  return p?.id;
}

const SOURCE = "https://sporting-events.org/";
const DATA_BASE = "https://sporting-events.org/data/";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_LEAGUES = 20;
const FETCH_GAP_MS = 500;
const MAX_BYTES = 5 * 2 ** 20;
const MAX_EVENTS = 3000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Games kept: from a day ago to 4 months ahead (a league with nothing this month shows its next). */
const KEEP_PAST_MS = DAY_MS;
const KEEP_AHEAD_MS = 120 * DAY_MS;
/** A chosen league with no game in the window still shows its next ones. */
const NEXT_PER_EMPTY_LEAGUE = 3;
/** The job fetches only while Sports is in use. */
const IN_USE_MS = 3 * DAY_MS;
/** How long the first request waits for the first fetch before answering with what there is. */
const FIRST_WAIT_MS = 8000;
const MAX_CHANNELS = 6;
// The source lists a month or so ahead; some sports (cricket) have a game every few weeks,
// so the page looks a month ahead.
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 45;

/**
 * Every league sporting-events.org offers (its /data/ page, 2026-10-22), grouped by sport in
 * this order; what a viewer can choose from ("Choose sports"). Names from the slug, with the
 * acronyms and accents put right.
 */
export const CATALOGUE: string[] = ["premier-league", "la-liga", "serie-a", "bundesliga", "ligue-1", "champions-league", "europa-league", "conference-league", "fa-cup", "nations-league", "fifa-world-cup", "copa-america", "football", "cricket", "ipl", "the-ashes", "champions-trophy", "tennis", "wimbledon", "french-open", "australian-open", "us-open-tennis", "atp-finals", "davis-cup", "table-tennis", "formula-1", "motogp", "nascar", "indycar", "wrc", "le-mans", "motorsport", "nba", "basketball", "march-madness", "nfl", "american-football", "college-football", "super-bowl", "nhl-ice-hockey", "ice-hockey", "stanley-cup", "mlb", "baseball", "world-series", "rugby-union", "rugby-league", "six-nations", "premiership-rugby", "nrl", "golf", "the-masters", "us-open-golf", "pga-championship", "the-open-championship", "ryder-cup", "mma", "boxing", "darts", "premier-league-darts", "pdc-world-championship", "snooker", "world-snooker-championship", "athletics", "diamond-league", "world-athletics-championships", "cycling", "tour-de-france", "vuelta-a-espana", "giro-ditalia", "horse-racing", "royal-ascot", "cheltenham-festival", "grand-national", "kentucky-derby", "melbourne-cup", "swimming", "rowing", "surfing", "winter-sports", "esports", "kabaddi", "field-hockey", "volleyball", "badminton", "wrestling"];
const NAME_FIXES: Record<string, string> = {
  ipl: "IPL", nba: "NBA", nfl: "NFL", mlb: "MLB", nrl: "NRL", mma: "MMA", wrc: "WRC", motogp: "MotoGP", nascar: "NASCAR",
  indycar: "IndyCar", "nhl-ice-hockey": "NHL", "fa-cup": "FA Cup", "formula-1": "Formula 1", "ligue-1": "Ligue 1",
  "us-open-tennis": "US Open (tennis)", "us-open-golf": "US Open (golf)", "atp-finals": "ATP Finals",
  "pga-championship": "PGA Championship", "le-mans": "Le Mans", "giro-ditalia": "Giro d'Italia",
  "vuelta-a-espana": "Vuelta a España", "pdc-world-championship": "PDC World Championship", "fifa-world-cup": "FIFA World Cup",
  "copa-america": "Copa América", "the-ashes": "The Ashes", "the-masters": "The Masters", "the-open-championship": "The Open",
  football: "Football (all)", basketball: "Basketball (all)", tennis: "Tennis (all)", golf: "Golf (all)", cricket: "Cricket (all)",
  motorsport: "Motorsport (all)", "american-football": "American football (all)", "ice-hockey": "Ice hockey (all)",
  baseball: "Baseball (all)", athletics: "Athletics (all)", cycling: "Cycling (all)", "horse-racing": "Horse racing (all)",
  kabaddi: "Kabaddi (from the TV guide)", "field-hockey": "Field hockey (from the TV guide)",
  volleyball: "Volleyball (from the TV guide)", badminton: "Badminton (from the TV guide)", wrestling: "Wrestling: WWE, AEW, TNA (from the TV guide)",
};
export function leagueName(slug: string): string {
  return NAME_FIXES[slug] ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** A viewer's chosen leagues, cleaned: known slugs only, at most 20; null when unusable. */
export function cleanLeagueChoice(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const known = new Set(CATALOGUE);
  const out = [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => known.has(x)))].slice(0, MAX_LEAGUES);
  return out;
}

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

/** League slug -> sport, first match wins (golf, darts and the races before the "league"/"cup" catch-all). */
const SPORT_OF: [RegExp, string][] = [
  [/cricket|ipl|ashes|champions-trophy/, "Cricket"],
  [/formula-1|motogp|nascar|indycar|wrc|le-mans|motorsport/, "Motorsport"],
  [/golf|masters|pga|open-championship|ryder-cup/, "Golf"],
  [/table-tennis/, "Table tennis"],
  [/tennis|wimbledon|french-open|australian-open|atp|davis-cup/, "Tennis"],
  [/horse-racing|royal-ascot|cheltenham|grand-national|kentucky-derby|melbourne-cup/, "Horse racing"],
  [/athletics|diamond-league/, "Athletics"],
  [/cycling|tour-de-france|vuelta|giro/, "Cycling"],
  [/swimming/, "Swimming"], [/rowing/, "Rowing"], [/surfing/, "Surfing"], [/winter-sports/, "Winter sports"],
  [/esports/, "Esports"],
  [/kabaddi/, "Kabaddi"],
  [/field-hockey/, "Field hockey"],
  [/volleyball/, "Volleyball"],
  [/badminton/, "Badminton"],
  [/wrestling/, "Wrestling"],
  [/darts|pdc|snooker/, "Darts and snooker"],
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

// ---- Matches from the TV guide ----------------------------------------------------------
// The free schedule has little cricket (8 events on 2026-10-22) while the owner's guide shows
// plenty ("1st ODI: India v West Indies-One-Day International Cricket"). For the viewer's
// sports that the guide covers well, matches are also read from the guide itself: the game
// IS the programme, so its channel and time need no matching. Rules, from the owner's guide
// (39,616 programme names): a name with the sport's words and two sides (" v " / " vs "); not
// highlights, countdowns, minis, fillers, bitesize, magic moments and the like; not an archive
// airing ("2026: Final: ..." starts with a year); and only the first airing of a title, and
// only when the title airs at most 3 different times in the guide unless it says "Live" (one
// "4th T20: India vs West Indies" aired 408 times: a replay).

/**
 * Every sport, as the guide names it (owner, 2026-10-22: "our IPTV has an EPG, use it").
 * `sides`: a match names two sides ("India v West Indies", "Roma vs. Genoa"); `live`: an
 * event without sides (a tennis tournament, a golf round) counts only when the name says Live;
 * `race`: motorsport, a session (race, qualifying, sprint, Grand Prix) or Live. First matching
 * sport wins, so ice hockey comes before field hockey and darts before football.
 */
// Sports surveyed in the owner's guide (2026-10-22: 1,227 channels in 7 sports groups, 45k
// programmes): football and cricket ~160 match listings each, then combat sports, NFL/CFL,
// NBA, MLB, tennis, F1, rugby; and sports the free schedule has nothing of: kabaddi, field
// hockey, volleyball, badminton, wrestling. US teams are often named without the league
// ("Toronto Raptors vs. New York Knicks", "Brewers at Dodgers"), hence the team names; a
// match by team names alone needs BOTH sides to be that league's teams ("Chiefs v Arrows" and
// "Dolphins v Badgers" were South African cricket).
const GUIDE_SPORTS: { sport: string; words: RegExp; teams?: RegExp; mode: "sides" | "live" | "race"; league?: string }[] = [
  { sport: "Cricket", words: / (?:cricket|t20i?|t10|odi|one day international|icc|cwc|acc|asia cup|champions trophy|ipl|big bash|bbl|psl|cpl|sa20|ilt20|the hundred|test match|ranji trophy|sheffield shield|super smash|legends league|world championship of legends) /, mode: "sides" },
  { sport: "Kabaddi", words: / (?:kabaddi|pkl) /, mode: "sides" },
  { sport: "Volleyball", words: / (?:volleyball|vnl) /, mode: "sides" },
  { sport: "Badminton", words: / (?:badminton|bwf) /, mode: "live" },
  { sport: "Wrestling", words: / (?:wwe|aew|tna|njpw|smackdown|raw|wrestling) /, mode: "live" },
  { sport: "Ice hockey", words: / (?:nhl|ice hockey|khl) /, teams: / (?:maple leafs|canadiens|bruins|blackhawks|penguins|oilers|flames|canucks|avalanche|lightning|capitals|islanders|flyers|sabres|senators|red wings|predators|golden knights|hurricanes|kraken|rangers|sharks|devils|stars|blues|wild|ducks|kings|jets|panthers|utah hockey club|mammoth|senators) /g, mode: "sides", league: "NHL" },
  { sport: "Field hockey", words: / (?:field hockey|hockey india league|fih|hockey) /, mode: "sides" },
  { sport: "Basketball", words: / (?:nba|wnba|basketball|euroleague|nbl) /, teams: / (?:hawks|celtics|nets|hornets|bulls|cavaliers|mavericks|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|bucks|timberwolves|pelicans|knicks|thunder|76ers|suns|trail blazers|spurs|raptors|wizards|magic|heat|jazz|kings|blazers) /g, mode: "sides", league: "NBA" },
  { sport: "American football", words: / (?:nfl|american football|college football|ncaa football) /, teams: / (?:falcons|ravens|bills|bears|bengals|browns|cowboys|broncos|packers|texans|colts|jaguars|chiefs|raiders|chargers|rams|dolphins|vikings|patriots|saints|eagles|steelers|49ers|seahawks|buccaneers|titans|commanders|alouettes|roughriders|blue bombers|elks|argonauts|tiger cats|stampeders|redblacks|cfl|cardinals|giants|jets|panthers|lions|titans|bc lions) /g, mode: "sides", league: "NFL / CFL" },
  { sport: "Baseball", words: / (?:mlb|baseball) /, teams: / (?:dodgers|yankees|mets|red sox|cubs|white sox|brewers|guardians|astros|braves|phillies|padres|mariners|orioles|blue jays|twins|royals|nationals|marlins|pirates|rockies|diamondbacks|giants|cardinals|rangers|tigers|reds|rays|athletics|angels) /g, mode: "sides", league: "MLB" },
  { sport: "Rugby", words: / (?:rugby|six nations|nrl|super rugby|sevens|top 14) /, mode: "sides" },
  { sport: "Darts and snooker", words: / (?:darts|snooker|pdc) /, mode: "sides" },
  { sport: "Combat sports", words: / (?:ufc|boxing|mma|fight night|one championship|bellator|pfl|bkfc) /, mode: "sides" },
  { sport: "Football", words: / (?:football|soccer|premier league|la ?liga|laliga|serie a|bundesliga|ligue 1|ligue1|champions league|europa league|conference league|youth league|isl|i league|fa cup|carabao cup|uefa|fifa|mls|saudi pro league|copa|super cup|durand cup|eredivisie|primeira liga) /, mode: "sides" },
  { sport: "Tennis", words: / (?:tennis|atp|wta|wimbledon|roland garros|davis cup) /, mode: "live" },
  { sport: "Golf", words: / (?:golf|pga|lpga|dp world tour|ryder cup|liv golf) /, mode: "live" },
  { sport: "Motorsport", words: / (?:formula 1|f1|motogp|moto2|moto3|nascar|indycar|wrc|formula e|f2) /, mode: "race" },
];
const RACE = / (?:live|race|corrida|carrera|qualif\w*|sprint|grand prix|gp) /;
const GUIDE_SKIP = / (?:highlights?|hl|hls|hlts|destaques|resumen|resumo|melhores|countdown|mini|fillers?|bitesize|magic|wonder|preview|review|rewind|classics?|best of|replay|repeat|recap|reaction|extra|build up|documentary|story|stories|legends|films?|inside|magazine|studio|analysis|post match|post race|pre race|prerace|pre qualifying|weekly|news|talk|show) /;
// "Brewers at Dodgers" is the US way of naming two sides.
const SIDES = / (?:v|vs|at) /;
const ARCHIVE = /^ (?:19|20)\d\d /;
const MAX_AIRINGS = 3;
/** "13/14", "2013/14", "2013-14": a season before last year means an archive airing. */
const SEASON = / (?:19|20)?(\d\d) (\d\d) /;
function oldSeason(n: string, nowSec: number): boolean {
  const m = SEASON.exec(n);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (b !== (a + 1) % 100) return false; // not a season, just two numbers
  const yy = new Date(nowSec * 1000).getUTCFullYear() % 100;
  return a < yy - 1;
}

/** The two sides of a match name, lowercased, in a fixed order ("" when it has none). */
function sidesKey(title: string): string {
  const n = norm(title).replace(/ (?:fc|afc|cf|sc|ac) /g, " ");
  const parts = n.split(/ (?:v|vs|at) /);
  if (parts.length !== 2) return "";
  // Two words each: the end of the first side, the start of the second ("cleveland cavaliers |
  // philadelphia 76ers"), so a competition before or after the sides does not count.
  const first = parts[0].trim().split(" ").slice(-2).join(" ");
  const second = parts[1].trim().split(" ").slice(0, 2).join(" ");
  return [first, second].sort().join("|");
}

export interface GuideProgramme { channelId: string; name: string; start: number; stop: number }
export interface GuideGame extends Game { end: number; channels: GameMatch[] }

/** "1st ODI: India v West Indies-One-Day International Cricket" -> title and competition. */
function splitGuideName(name: string): { title: string; competition: string } {
  const clean = name.replace(/^\s*live\s*[:\-–]?\s*/i, "").trim();
  const sides = clean.search(/\s(?:v|vs)\.?\s/i);
  // The competition after the sides, from the first dash after them ("1st ODI: India v West
  // Indies-One-Day International Cricket"; a dash inside the competition, "One-Day", stays).
  const dash = sides >= 0 ? clean.indexOf("-", sides) : -1;
  if (dash > 0 && dash < clean.length - 3) {
    const tail = clean.slice(dash + 1).trim();
    // A competition is two words or more ("T20 Cricket"); one word is the team's own
    // ("Hamilton Tiger-Cats").
    if (/[a-z]/i.test(tail) && tail.split(/\s+/).length >= 2) return { title: clean.slice(0, dash).trim(), competition: tail };
  }
  // Else the competition before the sides, ended by " - " or ": " ("ISL 2026-27 MD 1 -
  // Bengaluru FC vs Chennaiyin FC", "NBA 26/27: Pistons v Celtics").
  const before = sides > 0 ? clean.slice(0, sides) : "";
  const sep = Math.max(before.lastIndexOf(" - "), before.lastIndexOf(": "));
  if (sep > 2) return { title: clean.slice(sep + 2).trim(), competition: clean.slice(0, sep).trim() };
  // No sides (a tournament, a race): the name is the title.
  const colon = clean.indexOf(": ");
  if (sides < 0 && colon > 2) return { title: clean.slice(colon + 2).trim(), competition: clean.slice(0, colon).trim() };
  return { title: clean, competition: "On TV" };
}

/** The matches in these programmes for `sports` (see the rules above). Pure; times in seconds. */
export function guideGamesFrom(programmes: GuideProgramme[], sports: string[], nowSec: number): GuideGame[] {
  const rules = GUIDE_SPORTS.filter((r) => sports.includes(r.sport));
  if (!rules.length) return [];
  const byTitle = new Map<string, { sport: string; airings: GuideProgramme[]; live: boolean; league?: string }>();
  for (const p of programmes) {
    const n = norm(p.name);
    if (!n || NOT_LIVE.test(n) || GUIDE_SKIP.test(n) || ARCHIVE.test(n)) continue;
    // The first sport whose words match, of all sports (a darts match is not football even
    // when the viewer only follows football); kept only when the viewer follows it.
    // By team names: two DIFFERENT teams ("Teen Titans Go! Vs. Teen Titans" is one name twice).
    const rule = GUIDE_SPORTS.find((r) => r.words.test(n) || (!!r.teams && new Set(n.match(r.teams) ?? []).size >= 2));
    if (!rule || !sports.includes(rule.sport) || oldSeason(n, nowSec)) continue;
    const ok = rule.mode === "sides" ? SIDES.test(n) : rule.mode === "live" ? / live /.test(n) : RACE.test(n);
    if (!ok) continue;
    const sport = rule.sport;
    let t = byTitle.get(n);
    if (!t) byTitle.set(n, (t = { sport, airings: [], live: / live /.test(n), league: rule.league }));
    t.airings.push(p);
  }
  const out: GuideGame[] = [];
  for (const [key, t] of byTitle) {
    const starts = [...new Set(t.airings.map((a) => a.start))].sort((a, b) => a - b);
    if (!t.live && starts.length > MAX_AIRINGS) continue;
    const first = starts[0];
    const at = t.airings.filter((a) => Math.abs(a.start - first) <= 600);
    const end = Math.max(...at.map((a) => a.stop));
    if (end <= nowSec) continue;
    const split = splitGuideName(at[0].name);
    const title = split.title;
    // Found by team names, the name has no competition: the league's ("NHL").
    const competition = split.competition === "On TV" && t.league ? t.league : split.competition;
    const startMs = first * 1000;
    out.push({
      id: "g" + crypto.createHash("sha1").update(`${key}|${first}`).digest("base64url").slice(0, 11),
      league: "tv-guide",
      competition,
      sport: t.sport,
      date: new Date(startMs).toISOString().slice(0, 10),
      start: startMs,
      title,
      home: "",
      away: "",
      venue: "",
      status: "",
      broadcast: [],
      url: "",
      end: end * 1000,
      channels: [...new Map(at.map((a) => [a.channelId, { channelId: a.channelId, programme: a.name.slice(0, 160) }])).values()].slice(0, MAX_CHANNELS),
    });
  }
  return mergeSameMatch(out);
}

/** Games of the same sport with the same two sides starting within 3 hours: one game. */
function mergeSameMatch(games: GuideGame[]): GuideGame[] {
  games.sort((a, b) => a.start! - b.start!);
  const kept: GuideGame[] = [];
  for (const g of games) {
    const key = sidesKey(g.title);
    const twin = key ? kept.find((k) => k.sport === g.sport && sidesKey(k.title) === key && Math.abs(k.start! - g.start!) < 3 * HOUR_MS) : undefined;
    if (!twin) { kept.push(g); continue; }
    for (const c of g.channels) if (twin.channels.length < MAX_CHANNELS && !twin.channels.some((x) => x.channelId === c.channelId)) twin.channels.push(c);
    twin.end = Math.max(twin.end, g.end);
    if (twin.competition === "On TV" && g.competition !== "On TV") twin.competition = g.competition;
  }
  return kept;
}

let guideCache: { key: string; result: Promise<GuideGame[]> } | null = null;

/** Channel ids in a group whose name says replays (the owner's "SPORTS REPLAYS"); 10 minutes. */
let replayCache: { at: number; ids: Set<string> } | null = null;
async function replayChannels(): Promise<Set<string>> {
  if (replayCache && Date.now() - replayCache.at < 10 * 60_000) return replayCache.ids;
  const ids = new Set<string>();
  try {
    const profileId = await activeProfileIdForSports();
    const [genres, channels] = await Promise.all([readGenres("channel", profileId), readChannels(profileId)]);
    const replayGroups = new Set(genres.filter((g: any) => /replay/i.test(String(g.title ?? ""))).map((g: any) => String(g.id)));
    for (const c of channels) if (replayGroups.has(String(c.tv_genre_id))) ids.add(String(c.id));
  } catch { /* none known: nothing excluded */ }
  replayCache = { at: Date.now(), ids };
  return ids;
}

/**
 * Guide matches for `sports` now: the guide is scanned once per guide and hour for every
 * sport, and each viewer's sports are filtered from that (not one scan per set of sports).
 */
async function guideGames(sports: string[]): Promise<GuideGame[]> {
  const all = await guideGamesAll();
  return all.filter((g) => sports.includes(g.sport));
}
const ALL_GUIDE_SPORTS = [...new Set(GUIDE_SPORTS.map((r) => r.sport))];
async function guideGamesAll(): Promise<GuideGame[]> {
  const wanted = ALL_GUIDE_SPORTS;
  const snap = await getEpgSnapshot().catch(() => null);
  if (!snap) return [];
  const key = `${snap.rowKey}:${Math.floor(Date.now() / HOUR_MS)}`;
  if (guideCache?.key !== key) {
    const t0 = Date.now();
    const result = (async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const programmes: GuideProgramme[] = [];
      const pre = new RegExp(GUIDE_SPORTS.map((r) => r.words.source).join("|"));
      const replays = await replayChannels();
      await forEachProgramme(snap, nowSec - 4 * 3600, guideEnd(snap) + 1, (channelId, name, start, stop) => {
        // Only names of a wanted sport are kept (a few hundred of ~180k); never a channel of
        // a replays group ("SPORTS REPLAYS").
        if (!replays.has(channelId) && pre.test(norm(name))) programmes.push({ channelId, name, start, stop });
      });
      // Titles aired several times count every airing in the guide, so all of them are passed.
      const games = guideGamesFrom(programmes, wanted, nowSec);
      logger.info(`[sports] guide games: ${games.length} from ${programmes.length} sports programmes, ${Date.now() - t0} ms`);
      return games;
    })();
    result.catch(() => { if (guideCache?.key === key) guideCache = null; });
    guideCache = { key, result };
  }
  return guideCache.result;
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

/** Sports the free schedule has no file for: their matches come from the TV guide only. */
const GUIDE_ONLY = new Set(["kabaddi", "field-hockey", "volleyball", "badminton", "wrestling"]);

async function fetchLeague(slug: string): Promise<League> {
  if (GUIDE_ONLY.has(slug)) return { slug, competition: leagueName(slug), sport: sportOf(slug, ""), page: SOURCE, games: [] };
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

/** Leagues viewers chose (beyond the admin's), last asked for at; fetched while in use. */
const requested = new Map<string, number>();

/** The leagues to keep current: the admin's defaults and those asked for in the last 3 days. */
function wantedLeagues(): string[] {
  const now = Date.now();
  for (const [slug, at] of requested) if (now - at > IN_USE_MS) requested.delete(slug);
  return [...new Set([...configuredLeagues(), ...requested.keys()])];
}

/** Fetch every wanted league (one at a time, 500 ms apart). Returns a one-line summary. */
async function load(): Promise<string> {
  const slugs = wantedLeagues();
  settingsChanged = false;
  failedOnce.clear();
  const failed: string[] = [];
  for (let i = 0; i < slugs.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    try {
      leagues.set(slugs[i], await fetchLeague(slugs[i]));
    } catch (e: any) {
      failed.push(slugs[i]);
      failedOnce.add(slugs[i]);
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
  loading ??= load().finally(() => {
    loading = null;
    // Asked for while that load ran: one more pass for them.
    if (wantedLeagues().some((s) => !leagues.has(s) && !failedOnce.has(s))) void loadOnce();
  });
  return loading;
}
/** Leagues whose file failed in the last load (not retried at once, the hourly job does). */
const failedOnce = new Set<string>();

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

/**
 * GET /api/v2/sports: games from 6 hours ago to `days` ahead (not finished), with channels,
 * for `chosen` (the viewer's leagues; null: the admin's defaults).
 */
export async function sportsAnswer(days: number, chosen: string[] | null = null) {
  lastRequest = Date.now();
  const slugs = chosen && chosen.length ? chosen : configuredLeagues();
  for (const s of slugs) requested.set(s, Date.now());
  if (updatedAt === 0 || settingsChanged || slugs.some((s) => !leagues.has(s))) {
    await Promise.race([loadOnce().catch(() => ""), new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
  }
  const now = Date.now();
  const from = now - 6 * HOUR_MS;
  const to = now + days * DAY_MS;
  const all = slugs.flatMap((s) => leagues.get(s)?.games ?? []);
  const upcoming = (g: Game) =>
    g.status !== "completed" && g.status !== "finished" &&
    // A date-only game stays listed for its whole UTC day.
    (g.start !== null ? g.start >= from : dayStartMs(g.date) + DAY_MS > now);
  const games = all.filter((g) => upcoming(g) && sortKey(g) < to);
  // Cricket and the like: nothing this month, so their next few games (owner: "I chose cricket
  // and don't see it").
  const shown = new Set(games.map((g) => g.league));
  for (const slug of slugs) {
    if (shown.has(slug)) continue;
    games.push(...(leagues.get(slug)?.games ?? []).filter(upcoming).slice(0, NEXT_PER_EMPTY_LEAGUE));
  }
  const { matches, guide } = await matchesFor(all);
  // The viewer's sports the guide covers well (cricket, tennis): its matches too.
  const sportsChosen = [...new Set(slugs.map((s) => sportOf(s, "")))];
  const guideAll = guide ? (await guideGames(sportsChosen).catch(() => [] as GuideGame[])).filter((g) => g.start! < to) : [];
  // The same match in both (schedule and guide): one game, the schedule's, with the guide's
  // channels when the strict match found none (both teams named, within 6 hours).
  const extraChannels = new Map<string, GameMatch[]>();
  const fromGuide = guideAll.filter((gg) => {
    const twin = games.find((g) => {
      const needles = needlesOf(g);
      return !!needles && g.sport === gg.sport && (g.start === null || Math.abs(g.start - gg.start!) < 6 * HOUR_MS) && programmeMatches(gg.title, needles);
    });
    if (!twin) return true;
    if (!(matches.get(twin.id)?.length)) extraChannels.set(twin.id, gg.channels);
    return false;
  });
  return {
    source: { name: "sporting-events.org", url: SOURCE },
    updatedAt: updatedAt || null,
    loading: updatedAt === 0,
    guide,
    leagues: slugs.filter((s) => leagues.has(s)).map((s) => {
      const l = leagues.get(s)!;
      return { id: l.slug, name: l.competition, sport: l.sport, url: l.page };
    }),
    games: [
      ...games.map((g) => ({
        ...g,
        live: g.start !== null && now >= g.start && now < g.start + (LENGTH_MS[g.sport] ?? 3 * HOUR_MS),
        channels: matches.get(g.id)?.length ? matches.get(g.id)! : extraChannels.get(g.id) ?? [],
      })),
      ...fromGuide.map(({ end, ...g }) => ({ ...g, live: now >= g.start! && now < end })),
    ].sort((a, b) => sortKey(a) - sortKey(b)),
  };
}

export function parseDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_DAYS) : DEFAULT_DAYS;
}
