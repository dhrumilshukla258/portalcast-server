// Sports schedule parsing and the strict guide match (content/sports.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeague, needlesOf, programmeMatches, sportOf, norm, CATALOGUE, cleanLeagueChoice, leagueName } from "../src/content/sports";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const file = {
  competition: "Premier League",
  events: [
    { match: 1, date_utc: "2026-10-24", time_utc: "15:00", fixture: "Everton vs Chelsea", home_team: "Everton FC", away_team: "Chelsea", city: "Liverpool", country: "England", broadcast: "Sky Sports, TNT Sports", status: "scheduled", url: "https://sporting-events.org/event/x/" },
    { match: 2, date_utc: "2026-10-25", time_utc: "00:00", fixture: "United States Grand Prix", home_team: "", away_team: "", status: "confirmed", url: "https://evil.example/" },
    { match: 3, date_utc: "2025-01-01", time_utc: "15:00", fixture: "Too old", home_team: "A", away_team: "B" },
    { match: 4, date_utc: "26-10-24", time_utc: "15:00", fixture: "Bad date" },
    { match: 5, date_utc: "2026-10-24", time_utc: "15:00", fixture: "" },
  ],
};

test("parseLeague keeps valid games in the window and cleans fields", () => {
  const l = parseLeague("premier-league", file, NOW);
  assert.equal(l.sport, "Football");
  assert.deepEqual(l.games.map((g) => g.title), ["Everton vs Chelsea", "United States Grand Prix"]);
  const [a, b] = l.games;
  assert.equal(a.start, Date.parse("2026-10-24T15:00:00Z"));
  assert.deepEqual(a.broadcast, ["Sky Sports", "TNT Sports"]);
  assert.equal(a.venue, "Liverpool, England");
  // "00:00" means no time; a link off the source site falls back to the league page.
  assert.equal(b.start, null);
  assert.equal(b.url, "https://sporting-events.org/data/premier-league/");
  assert.equal(parseLeague("x", { events: "nope" }, NOW).games.length, 0);
});

test("sportOf puts darts and golf before the league catch-all", () => {
  assert.equal(sportOf("premier-league-darts", ""), "Darts and snooker");
  assert.equal(sportOf("us-open-golf", ""), "Golf");
  assert.equal(sportOf("ipl", ""), "Cricket");
  assert.equal(sportOf("bundesliga", ""), "Football");
  assert.equal(sportOf("esports", "Esports"), "Esports");
  assert.equal(sportOf("table-tennis", ""), "Table tennis");
  assert.equal(sportOf("melbourne-cup", ""), "Horse racing");
  assert.equal(sportOf("us-open-tennis", ""), "Tennis");
});

test("the catalogue: every league has a sport, viewer choices are cleaned", () => {
  // No rule: sportOf falls back to the competition name (here empty, so the slug).
  for (const slug of CATALOGUE) assert.notEqual(sportOf(slug, ""), slug, `${slug} has no sport`);
  assert.equal(leagueName("ipl"), "IPL");
  assert.equal(leagueName("premier-league"), "Premier League");
  assert.deepEqual(cleanLeagueChoice(["cricket", "CRICKET", "../etc", "tennis", 5]), ["cricket", "tennis"]);
  assert.equal(cleanLeagueChoice("cricket"), null);
  assert.equal(cleanLeagueChoice(CATALOGUE)!.length, 20);
});

test("match needs both teams as whole words, live programmes only", () => {
  const n = needlesOf({ home: "Everton FC", away: "Chelsea", title: "Everton vs Chelsea" })!;
  assert.ok(programmeMatches("Live: Premier League - Everton v Chelsea", n));
  assert.ok(programmeMatches("CHELSEA at EVERTON (Live)", n));
  assert.ok(!programmeMatches("Everton v Arsenal", n), "one team is not enough");
  assert.ok(!programmeMatches("Premier League Highlights: Everton v Chelsea", n), "highlights never count");
  assert.ok(!programmeMatches("EPL HL 26/27: Everton v Chelsea", n), "HL is highlights");
  assert.ok(!programmeMatches("Evertonians v Chelseafc", n), "whole words only");
});

test("events without teams need their whole name; unsafe games get no needles", () => {
  const n = needlesOf({ home: "", away: "", title: "The Ashes (1st Test)" })!;
  assert.ok(programmeMatches("Live Cricket: The Ashes - 1st Test, Day 1", n));
  assert.ok(!programmeMatches("The Ashes 2nd Test", n));
  assert.equal(needlesOf({ home: "", away: "", title: "Tennis" }), null);
  assert.equal(needlesOf({ home: "AB", away: "Chelsea", title: "x" }), null);
  assert.equal(norm("Atlético  Madrid!"), " atletico madrid ");
});

test("matches from the TV guide: first airing, no replays, highlights or archive", () => {
  const { guideGamesFrom } = require("../src/content/sports");
  const now = 1_000_000;
  const p = (channelId: string, name: string, start: number, hours = 4) => ({ channelId, name, start, stop: start + hours * 3600 });
  const progs = [
    p("1", "1st ODI: India v West Indies-One-Day International Cricket", now + 3600),
    p("2", "1st ODI: India v West Indies-One-Day International Cricket", now + 3600),
    p("1", "1st ODI: India v West Indies-One-Day International Cricket", now + 40000),
    p("3", "Cricket Highlights", now + 100),
    p("4", "2026: Final: India vs New Zealand-ICC Men's T20 Cricket World Cup", now + 200),
    ...[0, 1, 2, 3].map((i) => p("5", "4th T20: India vs West Indies-T20 Cricket", now + i * 20000)),
    p("6", "Live: Australia v England - The Ashes 1st Test Cricket", now - 3600, 8),
    p("7", "Premier League: Everton v Chelsea", now + 100),
  ];
  const games = guideGamesFrom(progs, ["Cricket"], now);
  const titles = games.map((g: any) => g.title).sort();
  assert.deepEqual(titles, ["1st ODI: India v West Indies", "Australia v England"]);
  const odi = games.find((g: any) => g.title.startsWith("1st ODI"));
  assert.equal(odi.competition, "One-Day International Cricket");
  assert.equal(odi.start, (now + 3600) * 1000);
  assert.deepEqual(odi.channels.map((c: any) => c.channelId), ["1", "2"]);
  assert.deepEqual(guideGamesFrom(progs, ["Football"], now), [], "only sports the guide covers");
});
