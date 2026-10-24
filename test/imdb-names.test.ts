// The IMDb index end to end on a few fixture titles (content/imdbIndex.ts): built from small
// files in IMDb's format, then matched against portal names, and the name check the correction
// job uses when the portal lists no people (nameFits).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const T = "\t";
const tsv = (dir: string, name: string, header: string, rows: string[][]) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, zlib.gzipSync([header, ...rows.map((r) => r.join(T))].join("\n") + "\n"));
  return file;
};

test("index, match and name check on fixture titles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-imdb-"));
  const files = {
    ratings: tsv(dir, "r.tsv.gz", "tconst\taverageRating\tnumVotes", [["tt0000001", "6.1", "10388"], ["tt0000002", "7.6", "280000"], ["tt0000003", "6.0", "99"], ["tt0000004", "8.0", "227441"], ["tt0000005", "5.9", "540"]]),
    basics: tsv(dir, "b.tsv.gz", "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres", [
      ["tt0000001", "movie", "The Moon", "Deo mun", "0", "2023", "\N", "129", "Drama"],
      ["tt0000002", "movie", "Killers of the Flower Moon", "Killers of the Flower Moon", "0", "2023", "\N", "206", "Crime"],
      ["tt0000003", "tvSeries", "Meet, Marry, Murder Hosted by Michelle Trachtenberg", "Meet, Marry, Murder Hosted by Michelle Trachtenberg", "0", "2021", "\N", "44", "Crime"],
      ["tt0000004", "movie", "Chicken Run", "Chicken Run", "0", "2000", "\N", "84", "Animation"],
      ["tt0000005", "movie", "Run", "Run", "0", "2025", "\N", "95", "Thriller"],
    ]),
    akas: tsv(dir, "a.tsv.gz", "titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle", [["tt0000004", "1", "Hennen Rennen", "DE", "\N", "\N", "\N", "0"]]),
    crew: tsv(dir, "c.tsv.gz", "tconst\tdirectors\twriters", []),
    principals: tsv(dir, "p.tsv.gz", "tconst\tordering\tnconst\tcategory\tjob\tcharacters", []),
    names: tsv(dir, "n.tsv.gz", "nconst\tprimaryName\tbirthYear\tdeathYear\tprimaryProfession\tknownForTitles", []),
  };
  const { buildImdbIndex, matchImdb, nameFits } = await import("../src/content/imdbIndex");
  assert.match(await buildImdbIndex(files as any), /5 titles/);

  // "The Moon" dubs that TMDB put on Killers of the Flower Moon: IMDb finds The Moon, and the
  // current title has no name the portal's could be.
  const m = await matchImdb("The Moon - Tamil HD", "movie", 2023);
  assert.equal(m?.imdbId, "tt0000001");
  assert.equal(m?.ownName, true);
  assert.equal(await nameFits("The Moon - Tamil HD", "tt0000002"), false);
  assert.equal(await nameFits("The Moon - Tamil HD", "tt0000001"), true);

  // "Run HD" on Chicken Run: not a name of it (its German one neither).
  assert.equal(await nameFits("Run HD", "tt0000004"), false);
  assert.equal(await nameFits("Chicken Run HD", "tt0000004"), true);
  assert.equal(await nameFits("Hennen Rennen", "tt0000004"), true, "another country's name fits too");

  // A portal that shortens: a longer name starting with the portal's title is a fit.
  assert.equal(await nameFits("Meet, Marry, Murder", "tt0000003"), true);

  // A title the index does not have: nothing can be said.
  assert.equal(await nameFits("The Moon", "tt9999999"), null);
});
