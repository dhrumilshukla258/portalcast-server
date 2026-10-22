// Sports schedule parsing and the strict guide match (content/sports.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeague, needlesOf, programmeMatches, sportOf, norm } from "../src/content/sports";

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
