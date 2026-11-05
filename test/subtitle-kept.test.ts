// Subtitles viewers kept on are listed first for the same movie or episode
// (content/subtitleChoices.ts; owner 2026-11-04: "now we know this is the right subtitle file").
import { test } from "node:test";
import assert from "node:assert/strict";
import { withKept, summarizeKept, isSubtitleKey, playingItemOf, cleanLabel } from "../src/content/subtitleChoices";

const os = (id: number) => ({ id: String(id), fileId: id, downloadId: `os:${id}`, source: "opensubtitles" as const, language: "en", releaseName: `os ${id}`, downloadCount: 10 });
const gd = (id: string) => ({ id, fileId: 0, downloadId: `gd:${id}`, source: "gestdown" as const, language: "en", releaseName: `gd ${id}`, downloadCount: 0 });

test("kept subtitles come first, most viewers first, with their count and timing", () => {
  const results = [os(1), os(2), gd("a"), gd("b")];
  const kept = summarizeKept([
    { subtitleKey: "gd:b", delayMs: 0, label: "gd b", updatedAt: "2026-11-04T10:00:00Z" },
    { subtitleKey: "os:2", delayMs: 1500, label: "os 2", updatedAt: "2026-11-04T11:00:00Z" },
    { subtitleKey: "os:2", delayMs: 1000, label: null, updatedAt: "2026-11-04T09:00:00Z" },
  ]);
  assert.deepEqual(kept.map((k) => [k.key, k.count, k.delayMs]), [["os:2", 2, 1250], ["gd:b", 1, 0]]);
  const out = withKept(results, kept, "en");
  assert.deepEqual(out.map((r) => r.downloadId), ["os:2", "gd:b", "os:1", "gd:a"]);
  assert.equal(out[0].kept, 2);
  assert.equal(out[0].keptDelayMs, 1250);
  assert.equal(out[2].kept, undefined);
});

test("a kept file the search no longer returns is listed from what was stored", () => {
  const kept = summarizeKept([{ subtitleKey: "gd:zz", delayMs: -250, label: "Ted.Lasso.S01E03.WEB", updatedAt: "2026-11-04T10:00:00Z" }]);
  const out = withKept([os(1)], kept, "en");
  assert.equal(out.length, 2);
  assert.deepEqual({ id: out[0].downloadId, source: out[0].source, name: out[0].releaseName, kept: out[0].kept, delay: out[0].keptDelayMs },
    { id: "gd:zz", source: "gestdown", name: "Ted.Lasso.S01E03.WEB", kept: 1, delay: -250 });
  // An OpenSubtitles one keeps its file id for older apps.
  const osOnly = withKept([], summarizeKept([{ subtitleKey: "os:77", delayMs: 0, label: null }]), "en");
  assert.equal(osOnly[0].fileId, 77);
  assert.equal(osOnly[0].releaseName, "Subtitle");
  // Nothing kept: the list is unchanged.
  const plain = [os(1), gd("a")];
  assert.equal(withKept(plain, [], "en"), plain);
});

test("only ids the server hands out are accepted", () => {
  for (const ok of ["os:6591914", "gd:2o3vBsgGaobYj3val4v9F6", "jfsub:abc.1:en"]) assert.equal(isSubtitleKey(ok), true, ok);
  for (const bad of ["", "os:", "os:abc", "gd:../x", "http://x", "jfsub:a b", 42, null, "x".repeat(300)]) assert.equal(isSubtitleKey(bad), false, String(bad));
});

test("the item comes from the stream token: movies and episodes only", () => {
  const base = { resource: "x", userLabel: "u", createdAt: 0, lastSeen: 0 };
  assert.deepEqual(playingItemOf({ ...base, itemType: "episode", itemId: "172692", profileId: 3 }, 1), { profileId: 3, itemType: "episode", itemId: "172692" });
  assert.deepEqual(playingItemOf({ ...base, itemType: "movie", itemId: "L12" }, 1), { profileId: 1, itemType: "movie", itemId: "L12" });
  // Versions are separate: a library movie's two files share its "L2", so each file counts alone.
  assert.equal(playingItemOf({ ...base, resource: "local:20", itemType: "movie", itemId: "L2" }, 1)?.itemId, "LF20");
  assert.equal(playingItemOf({ ...base, resource: "local:21", itemType: "movie", itemId: "L2" }, 1)?.itemId, "LF21");
  assert.equal(playingItemOf({ ...base, resource: "local:21", itemType: "episode", itemId: "LF21" }, 1)?.itemId, "LF21");
  assert.equal(playingItemOf({ ...base, itemType: "live", itemId: "5" }, 1), null);
  assert.equal(playingItemOf({ ...base, itemType: "movie" }, 1), null);
  assert.equal(playingItemOf(null, 1), null);
});

test("release names are stored as one short line", () => {
  assert.equal(cleanLabel("  Ted.Lasso\nS01E03\u0000 WEB  "), "Ted.Lasso S01E03 WEB");
  assert.equal(cleanLabel("x".repeat(300))!.length, 200);
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel(5), null);
});

test("one choice per viewer, title and language; the latest wins", async () => {
  const { sequelize } = await import("../src/db/index");
  const { SubtitleChoice } = await import("../src/models/SubtitleChoice");
  await SubtitleChoice.sync();
  const { recordKept, keptFor } = await import("../src/content/subtitleChoices");
  const ep = { profileId: 1, itemType: "episode" as const, itemId: "172692" };
  await recordKept(ep, 1, "en", "os:9330240", 0, "os file");
  await recordKept(ep, 1, "en", "gd:5YzM0VomMO6vXPU1qvzy8c", 500, "Ted Lasso 1x04");
  await recordKept(ep, 2, "en", "gd:5YzM0VomMO6vXPU1qvzy8c", 99_999, null);
  await recordKept(ep, 2, "fr", "os:1", 0, null);
  await recordKept({ ...ep, itemId: "172693" }, 3, "en", "os:2", 0, null);
  const kept = await keptFor(ep, "en");
  assert.deepEqual(kept.map((k) => [k.key, k.count]), [["gd:5YzM0VomMO6vXPU1qvzy8c", 2]]);
  // The delay is clamped to a minute; the label stays from the viewer who sent one.
  assert.equal(kept[0].delayMs, Math.round((500 + 60_000) / 2 / 50) * 50);
  assert.equal(kept[0].label, "Ted Lasso 1x04");
  await sequelize.close();
});
