// Gender of people (content/people.ts, content/peopleGender.ts): a known gender is never
// replaced by "TMDB has none", and a title's people TMDB did not mention are marked asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryTypes } from "sequelize";
import { initDB, sequelize } from "../src/db";
import { storePeople, storeTitleGenders, titlesNeedingGender, readGenders } from "../src/content/people";

const genderOf = async (tmdbPersonId: number) =>
  ((await sequelize.query("SELECT gender FROM people WHERE tmdbPersonId = ?", { replacements: [tmdbPersonId], type: QueryTypes.SELECT })) as any[])[0]?.gender ?? null;

test("gender from credits and from the fill job", async () => {
  await initDB();
  await storePeople("movie:1", [
    { kind: "cast", name: "Ann", role: null, order: 0, tmdbPersonId: 101, photo: null, gender: 1 },
    { kind: "cast", name: "Bob", role: null, order: 1, tmdbPersonId: 102, photo: null },
    { kind: "director", name: "Cy", role: null, order: 0, tmdbPersonId: 103, photo: null, gender: 0 },
  ]);
  assert.equal(await genderOf(101), 1);
  assert.equal(await genderOf(102), null, "not asked yet");
  assert.equal(await genderOf(103), 0, "TMDB has none");

  // Later credits without a gender keep the known one; a known one replaces 0.
  await storePeople("movie:2", [
    { kind: "cast", name: "Ann", role: null, order: 0, tmdbPersonId: 101, photo: null, gender: 0 },
    { kind: "cast", name: "Cy", role: null, order: 1, tmdbPersonId: 103, photo: null, gender: 2 },
  ]);
  assert.equal(await genderOf(101), 1);
  assert.equal(await genderOf(103), 2);

  assert.deepEqual((await titlesNeedingGender(10)).map((t) => t.titleKey), ["movie:1"]);
  // The fill: Bob is not in TMDB's answer, so he is marked asked (0); Ann's 1 stays.
  const known = await storeTitleGenders("movie:1", new Map([[101, 0], [103, 2]]));
  assert.equal(known, 1);
  assert.equal(await genderOf(101), 1);
  assert.equal(await genderOf(102), 0);
  assert.deepEqual(await titlesNeedingGender(10), []);
  const g = await readGenders();
  assert.deepEqual(g.map((r) => r.gender).sort(), [1, 2]);
});
