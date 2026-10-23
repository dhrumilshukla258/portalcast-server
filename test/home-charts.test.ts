// Charts per country (content/homeCharts.ts) and name matching (content/homeThemes.ts nameKey).
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerCountries } from "../src/content/homeCharts";
import { nameKey } from "../src/content/homeThemes";

test("a viewer's countries follow the languages they watch", () => {
  // Default country is the chartCountry setting (US unless set).
  assert.deepEqual(viewerCountries([]), ["US"]);
  assert.deepEqual(viewerCountries([{ code: "en", weight: 5 }]), ["US"]);
  assert.deepEqual(viewerCountries([{ code: "hi", weight: 3 }, { code: "ta", weight: 1 }]), ["IN"]);
  // A real mix gives both; a little of another language does not.
  assert.deepEqual(viewerCountries([{ code: "en", weight: 6 }, { code: "hi", weight: 4 }]), ["US", "IN"]);
  assert.deepEqual(viewerCountries([{ code: "en", weight: 9 }, { code: "ko", weight: 1 }]), ["US"]);
});

test("names match across spellings: accents, case, punctuation, a year, a leading The", () => {
  assert.equal(nameKey("The Night Agent"), nameKey("night agent"));
  assert.equal(nameKey("Amélie (2001)"), nameKey("amelie"));
  assert.equal(nameKey("Fast & Furious"), nameKey("Fast and Furious"));
  assert.notEqual(nameKey("Wednesday"), nameKey("Thursday"));
});
