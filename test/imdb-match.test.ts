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
  const meta = await tmdbMetaViaImdb("movie", "Finding Nemo - Eng Dub", "2003", undefined, {
    find: async () => { asked++; return 12; },
    details: async () => { asked++; return null; },
  });
  assert.equal(meta, null);
  assert.equal(asked, 0);
});

test("the portal's people as evidence: a shared director outweighs, a different one counts against", async () => {
  const { peopleEvidence, personHash, portalPeopleHashes } = await import("../src/content/imdbIndex");
  assert.equal(personHash("Christopher Nolan"), personHash("  christopher  NOLAN "));
  assert.equal(personHash("Amélie Poulain"), personHash("Amelie Poulain"));
  const credits = [{ h: personHash("Christopher Nolan"), role: 1 }, { h: personHash("Cillian Murphy"), role: 2 }, { h: personHash("Emily Blunt"), role: 2 }];
  const p = (directors: string, cast: string) => portalPeopleHashes({ directors, cast });
  let x = p("Christopher Nolan", "Cillian Murphy, Emily Blunt");
  assert.deepEqual(peopleEvidence(x.directors, x.cast, credits), { score: 6 + 4, director: 1, cast: 2 });
  x = p("Someone Else", "A, Bee Bee, Cee Cee, Dee Dee");
  assert.deepEqual(peopleEvidence(x.directors, x.cast, credits), { score: -3 - 2, director: 0, cast: 0 });
  x = p("", "N/A");
  assert.equal(peopleEvidence(x.directors, x.cast, credits), null, "nothing to compare");
  x = p("Christopher Nolan", "");
  assert.equal(peopleEvidence(x.directors, x.cast, []), null, "IMDb knows no people for it");
});

test("the portal's year decides only when IMDb's pick fits it and the current title clearly does not", async () => {
  const { yearDecides } = await import("../src/content/imdbIndex");
  const y = (year: number, endYear = 0) => ({ year, endYear });
  // "Lion" (2016) matched to The Lion King (1994): corrected.
  assert.equal(yearDecides("movie", 2016, null, y(1994), y(2016), 400_000), true);
  // A year in the name that disagrees with the portal's ("Duniyadari_2017", portal 2014): left alone.
  assert.equal(yearDecides("movie", 2014, 2017, y(2017), y(2013), 2423), false);
  // ...and one that agrees changes nothing.
  assert.equal(yearDecides("movie", 2016, 2016, y(1994), y(2016), 400_000), true);
  // A pick too little known to decide.
  assert.equal(yearDecides("movie", 2021, null, y(1983), y(2021), 19), false);
  // Within 2 years: a release-date difference, not a different title.
  assert.equal(yearDecides("movie", 2016, null, y(2014), y(2016), 5000), false);
  // A series whose run covers the portal's year is not contradicted.
  assert.equal(yearDecides("series", 2010, null, y(2004, 2012), y(2010), 5000), false);
  // A pick that "fits" only through an open run does not decide ("The Breakfast Club 4K", portal 2026).
  assert.equal(yearDecides("series", 2026, null, y(2008, 2008), y(2014), 50), false);
  // A series pick that started in that year does.
  assert.equal(yearDecides("series", 2019, null, y(2008, 2011), y(2019, 2021), 3000), true);
  // Nothing to compare.
  assert.equal(yearDecides("movie", 0, null, y(1994), y(2016), 400_000), false);
  assert.equal(yearDecides("movie", 2016, null, null, y(2016), 400_000), false);
});
