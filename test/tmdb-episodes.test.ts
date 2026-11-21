import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTmdbEpisodes,
  isPlaceholderTitle,
} from "../src/content/tmdbEpisodes";

test("isPlaceholderTitle recognizes show+season stamps and bare seasons while preserving real titles", () => {
  assert.equal(isPlaceholderTitle(""), true);
  assert.equal(isPlaceholderTitle("Ep. 1294"), true);
  assert.equal(isPlaceholderTitle("25-07-2026"), true);
  assert.equal(isPlaceholderTitle("Season 1"), true);
  assert.equal(isPlaceholderTitle("S01"), true);
  assert.equal(isPlaceholderTitle("The Big Bang Theory: Season 1"), true);
  assert.equal(isPlaceholderTitle("Two and a Half Men - Season 12"), true);
  assert.equal(
    isPlaceholderTitle("Young Sheldon : Season 04 To Current"),
    true,
  );

  assert.equal(isPlaceholderTitle("Pilot"), false);
  assert.equal(isPlaceholderTitle("The Big Bran Hypothesis"), false);
  assert.equal(isPlaceholderTitle("Season Finale"), false);
  assert.equal(isPlaceholderTitle("A Season for Change"), false);
});

test("applyTmdbEpisodes replaces show+season and repeated show-name placeholders with TMDB titles", () => {
  const tmdb = [
    {
      number: 1,
      name: "Pilot",
      overview: "Leonard and Sheldon meet Penny.",
      still: "/s1e1.jpg",
      runtime: 23,
      airDate: "2007-09-24",
    },
    {
      number: 2,
      name: "The Big Bran Hypothesis",
      overview: "Sheldon cleans Penny's apartment.",
      still: "/s1e2.jpg",
      runtime: 21,
      airDate: "2007-10-01",
    },
    {
      number: 3,
      name: "The Fuzzy Boots Corollary",
      overview: "Leonard asks a woman out.",
      still: "/s1e3.jpg",
      runtime: 22,
      airDate: "2007-10-08",
    },
  ];

  // Portal stamps "Episode N. The Big Bang Theory: Season 1" onto every episode
  const stamped = applyTmdbEpisodes(
    [
      {
        id: "1",
        name: "Episode 1. The Big Bang Theory: Season 1",
        title: "Episode 1. The Big Bang Theory: Season 1",
      },
      { id: "2", name: "Episode 2. The Big Bang Theory: Season 1" },
      { id: "3", name: "Episode 3. The Big Bang Theory: Season 1" },
    ],
    tmdb,
  );
  assert.equal(stamped[0].name, "Episode 1. Pilot");
  assert.equal(stamped[0].title, "Episode 1. Pilot");
  assert.equal(stamped[1].name, "Episode 2. The Big Bran Hypothesis");
  assert.equal(stamped[2].name, "Episode 3. The Fuzzy Boots Corollary");

  // Portal stamps bare show name onto 3+ episodes in a season
  const repeatedShow = applyTmdbEpisodes(
    [
      { id: "1", name: "Episode 1. The Big Bang Theory" },
      { id: "2", name: "Episode 2. The Big Bang Theory" },
      { id: "3", name: "Episode 3. The Big Bang Theory" },
    ],
    tmdb,
  );
  assert.equal(repeatedShow[0].name, "Episode 1. Pilot");
  assert.equal(repeatedShow[1].name, "Episode 2. The Big Bran Hypothesis");
  assert.equal(repeatedShow[2].name, "Episode 3. The Fuzzy Boots Corollary");

  // Real portal episode titles are preserved unchanged
  const realNames = applyTmdbEpisodes(
    [
      { id: "1", name: "Episode 1. Custom Portal Name" },
      { id: "2", name: "Episode 2. Another Real Title" },
      { id: "3", name: "Episode 3. Third Real Title" },
    ],
    tmdb,
  );
  assert.equal(realNames[0].name, "Episode 1. Custom Portal Name");
  assert.equal(realNames[1].name, "Episode 2. Another Real Title");
  assert.equal(realNames[2].name, "Episode 3. Third Real Title");
});
