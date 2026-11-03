// Title cleaning (content/titleClean.ts): tags come off, title words stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripReleaseNoise, normalizeTitleKey } from "../src/content/titleClean";

test("short language codes inside or at the start of a title are title words", () => {
  for (const name of ["Ben 10: Alien Force", "Ben-Hur", "Bigga Than Ben", "Gentle Ben", "PT Sir", "Mar Adentro", "Tel Aviv on Fire", "En Kadhale", "La Vie en Rose", "Mal Genio", "Kan Kan Men Bhagwan", "Barb and Star Go to Vista Del Mar"]) {
    assert.equal(stripReleaseNoise(name), name, name);
  }
});

test("short codes marked as tags still come off", () => {
  assert.equal(stripReleaseNoise("SpongeBob SquarePants - Ben"), "SpongeBob SquarePants");
  assert.equal(stripReleaseNoise("Title (Tam)"), "Title");
  assert.equal(stripReleaseNoise("Title Mal HD"), "Title");
  assert.equal(stripReleaseNoise("Movie - Hin"), "Movie");
  assert.equal(stripReleaseNoise("Rosa Morena PT"), "Rosa Morena"); // capitals at the end
  assert.equal(stripReleaseNoise("Ben-Hur - Eng Dub"), "Ben-Hur");
  assert.equal(stripReleaseNoise("PT Sir - Telugu HD"), "PT Sir");
});

test("full language names, quality marks and channel prefixes behave as before", () => {
  assert.equal(stripReleaseNoise("Finding Nemo - Eng Dub"), "Finding Nemo");
  assert.equal(stripReleaseNoise("Finding Nemo Tamil"), "Finding Nemo");
  assert.equal(stripReleaseNoise("Star Wars 1977 UHD"), "Star Wars 1977");
  assert.equal(stripReleaseNoise("Hum Tv : Raah E Noor"), "Raah E Noor");
  assert.equal(stripReleaseNoise("Star Plus Suhani Si Ek Ladki"), "Suhani Si Ek Ladki");
  assert.equal(normalizeTitleKey("Ben 10: Alien Force - Hindi"), normalizeTitleKey("Ben 10: Alien Force"));
});

test("a provider category's language, for titles TMDB has none for", async () => {
  const { languageOfCategory } = await import("../src/content/titleClean");
  const cases: [string, string | null][] = [
    ["GUJARATI | MOVIES", "gu"], ["GUJARATI | NOTOK & WEB SERIES", "gu"], ["Gujrati Natak", "gu"],
    ["HINDI | DUBBED", "hi"], ["BENGALI | BANGLA MOVIES", "bn"], ["TURKISH | SERIES", "tr"], ["ENGLISH | 4K UHD MOVIES", "en"],
    // No language, two languages, a word that only looks like one, subtitles only.
    ["KIDS | MOVIES", null], ["PORTUGUESE | SPANISH MOVIES", null], ["HINDU | RELIGIOUS", null],
    ["ENGLISH SUB", null], ["Korean Subbed", null], ["SOUTH | DUBBED", null], ["All", null], ["", null],
    // Short codes are not taken from a category name.
    ["MAL MOVIES", null], ["BEN TV", null],
  ];
  for (const [title, want] of cases) assert.equal(languageOfCategory(title), want, title);
});
