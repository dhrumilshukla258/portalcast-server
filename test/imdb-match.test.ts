// IMDb matching (content/imdbIndex.ts): what may be left after a title, and the step before the
// TMDB search (off by default; TMDB replaced here, so nothing goes out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { onlyTagsLeft, imdbKey, tmdbMetaViaImdb } from "../src/content/imdbIndex";

test("what may follow a title: tags, a year, a season; never more title words", () => {
  for (const left of ["", " - Eng Dub HD", " (Telugu)", " 4K", " 2016", " (2016) Hindi", ": Season 2", " S03", " Season 1 to current", " - PT", " Part 2"]) {
    assert.equal(onlyTagsLeft(left), true, JSON.stringify(left));
  }
  for (const left of [" 2", " Returns", ": The Clone Wars", " Alien Force", " and the City", " 10"]) {
    assert.equal(onlyTagsLeft(left), false, JSON.stringify(left));
  }
});

test("names as keys: accents, case, apostrophes and \"&\" do not matter", () => {
  assert.equal(imdbKey("Amélie"), "amelie");
  assert.equal(imdbKey("Fast & Furious"), "fast and furious");
  assert.equal(imdbKey("Don't Look Up"), "dont look up");
  assert.equal(imdbKey("Spider-Man: No Way Home"), "spider man no way home");
});

test("off by default: TMDB is not asked through IMDb, the caller searches as before", async () => {
  let asked = 0;
  const meta = await tmdbMetaViaImdb("movie", "Finding Nemo - Eng Dub", "2003", {
    find: async () => { asked++; return 12; },
    details: async () => { asked++; return null; },
  });
  assert.equal(meta, null);
  assert.equal(asked, 0);
});
