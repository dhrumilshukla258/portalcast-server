// Discover's filtered browse (content/discoverIndex.ts browse): genres AND together, and
// "not these genres" leaves out any title carrying one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browse, type DiscoverIndex } from "../src/content/discoverIndex";

// Six titles, newest first (rank = position); type 1 = movie, 2 = series.
function index(): DiscoverIndex {
  const ids = ["m1", "m2", "m3", "s4", "m5", "m6"];
  const genre: Record<string, number[]> = {
    Crime: [0, 1, 2, 3, 5],
    Drama: [1, 3, 4],
    Horror: [2, 5],
    Comedy: [4],
  };
  const postings = { genre: new Map<string, Int32Array>(), country: new Map(), theme: new Map(), network: new Map() } as DiscoverIndex["postings"];
  for (const [g, ranks] of Object.entries(genre)) postings.genre.set(g, Int32Array.from(ranks));
  return {
    ids,
    type: Uint8Array.from([1, 1, 1, 2, 1, 1]),
    lang: new Int32Array(6).fill(-1),
    langs: [],
    langIndex: new Map(),
    rankOf: new Map(ids.map((id, r) => [id, r])),
    postings,
    facets: {} as DiscoverIndex["facets"],
    builtAt: 0,
  } as DiscoverIndex;
}

const q = (over: Partial<Parameters<typeof browse>[1]>) => ({ tags: [], hidden: new Set<string>(), page: 1, pageSize: 50, ...over });
const g = (...values: string[]) => values.map((value) => ({ kind: "genre" as const, value }));

test("several genres: a title must have all of them", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime", "Drama") })), { ids: ["m2", "s4"], total: 2 });
});

test("not a genre: titles with it are left out", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Horror") })), { ids: ["m1", "m2", "s4"], total: 3 });
  // Two excluded: any of them leaves a title out.
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Horror", "Drama") })), { ids: ["m1"], total: 1 });
});

test("only exclusions: everything else, with type, hidden titles and pages applied", () => {
  assert.deepEqual(browse(index(), q({ exclude: g("Crime") })), { ids: ["m5"], total: 1 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), type: "movie" })), { ids: ["m1", "m2", "m5"], total: 3 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), hidden: new Set(["m2"]) })), { ids: ["m1", "s4", "m5"], total: 3 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), pageSize: 2, page: 2 })), { ids: ["s4", "m5"], total: 4 });
});

test("an unknown excluded genre changes nothing; no filters is the whole list", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Western") })), { ids: ["m1", "m2", "m3", "s4", "m6"], total: 5 });
  assert.deepEqual(browse(index(), q({})), { ids: ["m1", "m2", "m3", "s4", "m5", "m6"], total: 6 });
});
