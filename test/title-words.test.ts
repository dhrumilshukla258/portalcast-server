// A portal's changes to the default title word lists (content/titleClean.ts setTitleWordEdits,
// content/titleWords.ts cleanEdits): added and removed words work, odd input is refused, and no
// changes means exactly the defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripReleaseNoise, extractLanguageInfo, channelOf, setTitleWordEdits, defaultTitleWords } from "../src/content/titleClean";
import { cleanEdits, wordsOf, TitleWordsError } from "../src/content/titleWords";

const withEdits = (raw: unknown, fn: () => void) => {
  setTitleWordEdits(cleanEdits(raw));
  try { fn(); } finally { setTitleWordEdits(null); }
};

test("a tag added or removed for a portal", () => {
  assert.equal(stripReleaseNoise("Title HEVC"), "Title HEVC");
  withEdits({ tags: { add: ["HEVC"], remove: ["hd"] } }, () => {
    assert.equal(stripReleaseNoise("Title HEVC"), "Title");
    assert.equal(stripReleaseNoise("Title HD"), "Title HD", "hd removed: kept as a word");
    assert.equal(stripReleaseNoise("Title 4K"), "Title", "other tags as before");
  });
  assert.equal(stripReleaseNoise("Title HD"), "Title", "back to the defaults");
});

test("a spelling given another language: \"eng dub\" means English on another portal", () => {
  assert.equal(extractLanguageInfo("The Others - Eng Dub").audio, "Hindi"); // the default
  withEdits({ languages: { add: [{ spelling: "eng dub", language: "english" }] } }, () => {
    assert.equal(extractLanguageInfo("The Others - Eng Dub").audio, "English");
    assert.equal(stripReleaseNoise("The Others - Eng Dub"), "The Others");
  });
  withEdits({ languages: { add: [{ spelling: "hin dub", language: "Hindi" }] } }, () => {
    assert.equal(stripReleaseNoise("Finding Nemo - Hin Dub"), "Finding Nemo");
    assert.equal(extractLanguageInfo("Finding Nemo - Hin Dub").audio, "Hindi");
  });
});

test("a channel added (with its badge as typed) or removed", () => {
  withEdits({ channels: { add: ["Geo Kahani Plus"] } }, () => {
    assert.equal(stripReleaseNoise("Geo Kahani Plus : Mere Paas Tum Ho"), "Mere Paas Tum Ho");
    assert.equal(channelOf("Geo Kahani Plus : Mere Paas Tum Ho"), "Geo Kahani Plus");
  });
  assert.equal(stripReleaseNoise("Hum Tv : Raah E Noor"), "Raah E Noor");
  withEdits({ channels: { remove: ["hum tv"] } }, () => {
    assert.equal(stripReleaseNoise("Hum Tv : Raah E Noor"), "Hum Tv : Raah E Noor");
    assert.equal(channelOf("Hum Tv : Raah E Noor"), null);
  });
});

test("odd input is refused; words are matched as written, never as patterns", () => {
  for (const bad of [{ tags: { add: [".*"] } }, { tags: { add: ["a|b"] } }, { channels: { add: ["(x)"] } }, { tags: { add: "hd" } }, { tags: { add: ["x".repeat(80)] } }]) {
    assert.throws(() => cleanEdits(bad), TitleWordsError, JSON.stringify(bad));
  }
  withEdits({ tags: { add: ["A+"] } }, () => assert.equal(stripReleaseNoise("Title - A+ Rated"), "Title - A+ Rated"));
  assert.deepEqual(wordsOf(cleanEdits({ tags: { add: ["HEVC", "hevc"] } })), ["hevc"]);
});

test("the default lists, as Admin shows them", () => {
  const d = defaultTitleWords();
  assert.ok(d.languages.find((l) => l.language === "Hindi")?.spellings.includes("eng dub"));
  assert.ok(d.tags.includes("dual audio") && d.tags.includes("blu-ray") && d.tags.includes("dub"));
  assert.ok(d.channels.includes("hum tv") && d.channels.includes("star plus"));
});
