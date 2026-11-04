// TMDB result picking for one-word names (content/tmdb.ts oneWordFits) and the titles the
// one-time re-match picks out (metaEnrichment.ts oneWordMismatches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResult, oneWordFits } from "../src/content/tmdb";
import { oneWordMismatches } from "../src/content/metaEnrichment";

const movie = (id: number, title: string, date = "2026-01-01", popularity = 50) => ({ id, title, original_title: title, release_date: date, popularity });

test("a one-word name does not take a longer title it is only a word of", () => {
  const q = { query: "VS", strict: false };
  assert.equal(pickResult([movie(1204680, "Coyote vs. Acme", "2026-08-28", 90)], q, "movie"), null);
  assert.equal(pickResult([movie(767, "Harry Potter and the Half-Blood Prince")], { query: "Half", strict: false }, "movie"), null);
  assert.equal(pickResult([movie(489, "Good Will Hunting")], { query: "Will", strict: false }, "movie"), null);
});

test("a one-word name still takes its own title, a spelling of it, or a two-word title it opens", () => {
  assert.equal(pickResult([movie(1, "Coyote vs. Acme", "2026-01-01", 99), movie(2, "VS", "2018-01-01", 1)], { query: "VS", strict: false }, "movie")?.id, 2);
  assert.equal(pickResult([movie(3, "Bahurupi")], { query: "Bohurupi", strict: false }, "movie")?.id, 3);
  assert.equal(pickResult([movie(4, "Narvik")], { query: "Narvik", strict: false }, "movie")?.id, 4);
  assert.equal(oneWordFits("kill", ["kill bill"]), true);
  // Names of more words are not checked by this rule.
  assert.equal(oneWordFits("the boys", ["the boys from brazil"]), true);
});

test("the re-match picks one-word names that are a middle word of their TMDB title", () => {
  const rows = [
    { id: "a", trimmedName: "VS", originalTitle: "Coyote vs. Acme" },
    { id: "b", trimmedName: "Golden", originalTitle: "Kingsman: The Golden Circle" },
    { id: "c", trimmedName: "Narvik", originalTitle: "Kampen om Narvik" },
    { id: "d", trimmedName: "Athade", originalTitle: "Athade Oka Sainyam" },
    { id: "e", trimmedName: "Bigg Boss", originalTitle: "बिग बॉस" },
    { id: "f", trimmedName: "Half", originalTitle: "Harry Potter and the Half-Blood Prince", tmdbIdLocked: 767 },
    { id: "g", trimmedName: "Coyote vs. Acme", originalTitle: "Coyote vs. Acme" },
  ];
  assert.deepEqual(oneWordMismatches(rows).map((r) => r.id), ["a", "b", "c"]);
});
