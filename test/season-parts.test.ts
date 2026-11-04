// Shows a provider lists one season at a time (content/seasonParts.ts), with names from a real
// catalog (2026-11-03).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seasonMarkerOf, seriesBaseKey, withoutSeasonMarker, audioLanguageOf, qualityRankOf,
  numberSeasons, mergeSeasonLists, mergeEpisodeLists, encodeSeasonId, decodeSeasonId, onePerLanguage,
} from "../src/content/seasonParts";
import { groupKeyFor, planSeasonPartMatches } from "../src/content/metaEnrichment";

test("season markers: one season, ranges, to current", () => {
  const cases: [string, { base: string; from: number; to: number | null } | null][] = [
    ["Lost: Season 2", { base: "lost", from: 2, to: 2 }],
    ["Asianet : Mylanchi S07", { base: "mylanchi", from: 7, to: 7 }],
    ["Pati Patni Aur Woh 4K Season 01", { base: "pati patni aur woh", from: 1, to: 1 }],
    ["MeToo The Wolf Of Bollywood English Dubbed Season02", { base: "metoo the wolf of bollywood", from: 2, to: 2 }],
    ["The Simpsons : Season 1 to 10", { base: "the simpsons", from: 1, to: 10 }],
    ["Ancient Aliens : Season 16 To Current", { base: "ancient aliens", from: 16, to: null }],
    ["Black Mirror: Season 5 To Currrent", { base: "black mirror", from: 5, to: null }],
    ["Star Vijay : Super Singer S09 To Current", { base: "super singer", from: 9, to: null }],
    ["Star Plus : Yeh Rishta Kya Kehlata Hai S1 to S64", { base: "yeh rishta kya kehlata hai", from: 1, to: 64 }],
    ["Shark Tank : Season 09 & 10", { base: "shark tank", from: 9, to: 10 }],
    ["Kingdom: Season 2.", { base: "kingdom", from: 2, to: 2 }],
    // "Telugu" is a language tag, as in every other title.
    ["Star Maa : Bigg Boss Telugu S10 2026", { base: "bigg boss", from: 10, to: 10 }],
    ["24: Season 8", { base: "24", from: 8, to: 8 }],
    // Not season markers.
    ["Mating Season 4K", null],
    ["Season of the Witch", null],
    ["Friends S01E05", null],
    ["Season 2", null],
    ["Lost", null],
  ];
  for (const [name, want] of cases) assert.deepEqual(seasonMarkerOf(name), want, name);
  assert.equal(seriesBaseKey("Lost: Season 2"), seriesBaseKey("Lost"));
});

test("display names lose the marker; other names stay", () => {
  assert.equal(withoutSeasonMarker("Lost: Season 2"), "Lost");
  assert.equal(withoutSeasonMarker("Mylanchi S07"), "Mylanchi");
  assert.equal(withoutSeasonMarker("The Simpsons : Season 1 to 10"), "The Simpsons");
  assert.equal(withoutSeasonMarker("Hustle 2012"), "Hustle 2012");
  assert.equal(withoutSeasonMarker("Mating Season"), "Mating Season");
});

test("season parts share their show's group; other series keep theirs", () => {
  assert.equal(groupKeyFor("series", "Lost: Season 2", "", 4607), groupKeyFor("series", "Lost", "2004", 4607));
  assert.equal(groupKeyFor("series", "Lost: Season 2", "", 4607), "series:lost:tmdb4607");
  // Unmatched parts: the show's name in its category (each season aired in its own year).
  assert.equal(groupKeyFor("series", "Metoo Wolf Of Bollywood -S01", "2019", null, "10"), groupKeyFor("series", "Metoo Wolf Of Bollywood - S02", "2020", null, "10"));
  assert.notEqual(groupKeyFor("series", "Rahasya Romancho S01", "", null, "10"), groupKeyFor("series", "Rahasya Romancho S01", "", null, "36"));
  // No marker: as before.
  assert.equal(groupKeyFor("series", "Kim's Convenience 2016", "2016", 65495), "series:kims convenience:tmdb65495");
  assert.equal(groupKeyFor("series", "Out Story", "2021", null, "10"), "series:out story:2021");
  // Movies are never touched.
  assert.equal(groupKeyFor("movie", "Season 2", "2020", null), "movie:season 2:2020");
});

test("audio language: the category first, then the title's tags", () => {
  assert.equal(audioLanguageOf("Game Of Thrones: Season 8", "HINDI | DUBBED"), "Hindi");
  assert.equal(audioLanguageOf("Game Of Thrones: Season 8", "ENGLISH | TV & WEB SERIES"), "English");
  assert.equal(audioLanguageOf("Some Film", "SOUTH | DUBBED"), "Hindi");
  assert.equal(audioLanguageOf("Ek Thi Begum S02 - Telugu", "PREMIUM"), "Telugu");
  assert.equal(audioLanguageOf("SpongeBob SquarePants : Season 01 to Current", "KIDS | TV SHOWS"), "");
});

test("quality: 4K over HD over cam", () => {
  assert.ok(qualityRankOf("Pati Patni Aur Woh 4K Season 01") > qualityRankOf("Pati Patni Aur Woh S01 HD"));
  assert.ok(qualityRankOf("X Season 3 HD") > qualityRankOf("X Season 3 HDCAM"));
  assert.equal(qualityRankOf("Lost: Season 2"), 0);
  assert.equal(qualityRankOf("", "4k"), 5);
});

test("merged season ids name their parts and survive a round trip", () => {
  const id = encodeSeasonId(7, [{ part: "574273", season: "130102" }, { part: "515872", season: "1" }]);
  assert.equal(id, "m:7:574273.130102~515872.1");
  assert.deepEqual(decodeSeasonId(id), { n: 7, sources: [{ part: "574273", season: "130102" }, { part: "515872", season: "1" }] });
  // A "+" join (an older form) or one decoded from a query string as a space also reads.
  assert.equal(decodeSeasonId("m:7:1.2 3.4")?.sources.length, 2);
  for (const bad of ["5601", "", null, "m:", "m:7:", "m:7:abc.1", "m:x:1.2", "m:7:1.2;drop"]) assert.equal(decodeSeasonId(bad), null, String(bad));
});

const season = (id: string, n: number | string, extra: Record<string, any> = {}) => ({ id, season_number: String(n), name: `Season ${n}`, is_season: true, ...extra });

test("the name's season number wins over a provider that files one season as 1", () => {
  // "Asianet : Mylanchi S07": the provider lists its 27 episodes under season 1.
  assert.deepEqual(numberSeasons({ id: "515872", name: "Asianet : Mylanchi S07", quality: 0, seasons: [season("1", 1)] }).map((s) => s.n), [7]);
  // A range keeps the provider's numbers, moved into the range when they fall below it.
  assert.deepEqual(numberSeasons({ id: "1", name: "Mom : Seasons 03 To 08", quality: 0, seasons: [season("a", 1), season("b", 2)] }).map((s) => s.n), [3, 4]);
  assert.deepEqual(numberSeasons({ id: "2", name: "The Simpsons : Season 11 to 29", quality: 0, seasons: [season("a", 11), season("b", 12)] }).map((s) => s.n), [11, 12]);
  // A full series: the provider's numbers.
  assert.deepEqual(numberSeasons({ id: "3", name: "Westworld", quality: 5, seasons: [season("5600", 1), season("5601", 2)] }).map((s) => s.n), [1, 2]);
  // Xtream: the season id is its number.
  assert.deepEqual(numberSeasons({ id: "4", name: "Lost", quality: 0, seasons: [{ id: 2, name: "Season 2" }] }).map((s) => s.n), [2]);
});

test("seasons merge across parts; a season two parts have is listed once, best copy first", () => {
  const merged = mergeSeasonLists([
    { id: "22041", name: "Westworld", quality: 0, opened: true, seasons: [season("5600", 1), season("5601", 2), season("5602", 3)] },
    { id: "20983", name: "Westworld: Season 3 4K", quality: 5, seasons: [season("9001", 1)] },
    { id: "20990", name: "Westworld: Season 4", quality: 0, seasons: [season("9100", 4)] },
  ]);
  assert.deepEqual(merged.map((s) => s.name), ["Season 4", "Season 3", "Season 2", "Season 1"]);
  assert.equal(merged[1].id, "m:3:20983.9001~22041.5602"); // the 4K copy first
  assert.equal(merged[0].id, "m:4:20990.9100");
  assert.equal(merged[0].season_number, "4");
  assert.equal(merged[3].video_id, "22041");
});

const ep = (id: string, n: number, title = `Episode ${n}`, extra: Record<string, any> = {}) => ({ id, series_number: String(n), name: `Episode ${n}. ${title}`, ...extra });

test("episodes: best quality wins, gaps are filled, a real title beats a bare one", () => {
  // Season 3 in HD (episodes 1-3) and as a cam copy (1-5).
  const hd = { quality: 3, items: [ep("h3", 3), ep("h2", 2), ep("h1", 1)] };
  const cam = { quality: 1, items: [ep("c5", 5), ep("c4", 4), ep("c3", 3), ep("c2", 2), ep("c1", 1)] };
  assert.deepEqual(mergeEpisodeLists([hd, cam]).map((e) => e.id), ["c5", "c4", "h3", "h2", "h1"]);
  // Same quality (Mylanchi): the copy with the episode's own title.
  const bare = { quality: 0, items: [{ id: "b27", series_number: "27", name: "Episode 27. Episode 27" }] };
  const titled = { quality: 0, items: [ep("t27", 27, "28-05-2023 : And the Winner Is?"), ep("t26", 26, "A Finale to Remember")] };
  assert.deepEqual(mergeEpisodeLists([bare, titled]).map((e) => e.id), ["t27", "t26"]);
  // One copy: unchanged.
  assert.equal(mergeEpisodeLists([hd]), hd.items);
});

test("the version picker: one entry per language for a show made of season parts", () => {
  const rows = [
    { id: "series_1", name: "Game Of Thrones: Season 8", cat: "ENGLISH" },
    { id: "series_2", name: "Game Of Thrones: Season 7", cat: "ENGLISH" },
    { id: "series_3", name: "Game Of Thrones", cat: "ENGLISH" },
    { id: "series_4", name: "Game Of Thrones: Season 8", cat: "HINDI | DUBBED" },
  ];
  const kept = onePerLanguage(rows, (r) => audioLanguageOf(r.name, r.cat));
  assert.deepEqual(kept.map((r) => r.id), ["series_1", "series_4"]); // the representative stays
  const hindiParts = [rows[0], { id: "series_5", name: "Game Of Thrones: Season 7", cat: "HINDI | DUBBED" }, { id: "series_6", name: "Game Of Thrones", cat: "HINDI | DUBBED" }];
  const hi = onePerLanguage(hindiParts, (r) => audioLanguageOf(r.name, r.cat));
  assert.deepEqual(hi.map((r) => r.id), ["series_1", "series_6"]); // Hindi: the full series over a part
  // A group without season parts: as before.
  const plain = [{ id: "a", name: "Kaali 4K" }, { id: "b", name: "Kaali - Web Series" }];
  assert.equal(onePerLanguage(plain, () => "Hindi"), plain);
});

test("wrongly matched or unmatched season parts are matched to their show, and only then", () => {
  const cat = new Map([["4", "en"], ["28", "ml"], ["9", "hi"]]);
  const r = (id: string, name: string, tmdbId: number | null, originalTitle: string | null, portalCategoryId = "4", tmdbIdLocked: number | null = null) =>
    ({ id, name, tmdbId, originalTitle, portalCategoryId, tmdbIdLocked });
  const rows = [
    // Lost: two parts matched to Attack on Titan, four to Lost.
    r("series_1", "Lost: Season 1", 1429, "進撃の巨人"), r("series_2", "Lost: Season 2", 1429, "進撃の巨人"),
    r("series_3", "Lost: Season 3", 4607, "Lost"), r("series_4", "Lost: Season 4", 4607, "Lost"),
    r("series_5", "Lost: Season 5", 4607, "Lost"), r("series_6", "Lost: Season 6", 4607, "Lost"),
    // Mylanchi: one unmatched part beside a matched one, same category.
    r("series_7", "Asianet : Mylanchi S07", null, null, "28"), r("series_8", "Asianet : Mylanchi Season 7", 235327, "Mylanchi", "28"),
    // Bigg Boss: the right match is in another script and most parts share it.
    r("series_9", "Colors : Bigg Boss S17", 11436, "बिग बॉस", "9"), r("series_10", "Colors : Bigg Boss S18", 11436, "बिग बॉस", "9"),
    r("series_11", "Bigg Boss S01", 72908, "Bigg Boss", "9"),
    // Empire: two real shows named Empire; a part matched to one of them stays.
    r("series_12", "Empire: Season 2", 7861, "Empire"), r("series_13", "Empire: Season 1", 61733, "Empire"),
    // Locked by hand: never moved.
    r("series_14", "Six: Season 1", 95777, "Club Friday", "4", 95777), r("series_15", "Six", 84847, "Six"),
  ];
  const moves = planSeasonPartMatches(rows, cat).map((m) => `${m.row.id}->${m.tmdbId}`).sort();
  assert.deepEqual(moves, ["series_1->4607", "series_2->4607", "series_7->235327"]);
});

test("copies of one title spelled with different punctuation share a key (Golmaal)", () => {
  const key = groupKeyFor("movie", "Golmaal - Fun Unlimited", "2006", 19670);
  assert.equal(key, "movie:golmaal fun unlimited:tmdb19670");
  assert.equal(groupKeyFor("movie", "Golmaal – Fun Unlimited UHD", "2006", 19670), key);
  assert.equal(groupKeyFor("movie", "Golmaal: Fun Unlimited", "2006", 19670), key);
  assert.equal(groupKeyFor("movie", "Don't Log Off", "", 728623), groupKeyFor("movie", "Don’t Log Off", "", 728623));
  assert.equal(groupKeyFor("movie", "Ape vs. Mecha Ape", "", 1), groupKeyFor("movie", "Ape vs Mecha Ape", "", 1));
  // The name still counts: a wrong match to the same TMDB id stays apart.
  assert.notEqual(groupKeyFor("movie", "Half", "", 767), groupKeyFor("movie", "Harry Potter and the Half-Blood Prince", "", 767));
  // A name of punctuation only keeps it.
  assert.equal(groupKeyFor("movie", "...", "", null).startsWith("movie:"), true);
});
