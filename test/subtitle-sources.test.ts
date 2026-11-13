// OpenSubtitles' files go last while its downloads fail (content/opensubtitles.ts): on
// 2026-11-04 its download endpoint answered 503 for hours while search worked, and each top
// result failed in turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadableFirst, noteOpenSubtitlesDownload, openSubtitlesDownloadsFailing, openSubtitlesHeaders } from "../src/content/opensubtitles";

const r = (id: string, source: string) => ({ id, source });

test("OpenSubtitles results go last only while its downloads fail", () => {
  const list = [r("os1", "opensubtitles"), r("jf", "jellyfin"), r("os2", "opensubtitles"), r("gd", "gestdown")];
  assert.deepEqual(downloadableFirst(list, false).map((x) => x.id), ["os1", "jf", "os2", "gd"]);
  assert.deepEqual(downloadableFirst(list, true).map((x) => x.id), ["jf", "gd", "os1", "os2"]);
});

test("a 5xx or the shared pool's limit marks downloads failing for a while; one that works clears it", () => {
  const t0 = 1_000_000;
  noteOpenSubtitlesDownload(null, true, t0);
  assert.equal(openSubtitlesDownloadsFailing(t0), false);
  noteOpenSubtitlesDownload(503, false, t0);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 60_000), true);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 16 * 60_000), false);
  noteOpenSubtitlesDownload(406, true, t0);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 1), true);
  noteOpenSubtitlesDownload(null, true, t0 + 2);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 3), false);
  // A linked account's own limit is that user's alone.
  noteOpenSubtitlesDownload(406, false, t0);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 1), false);
});

test("failures in a row keep OpenSubtitles last for longer, up to 6 hours; a working download resets it", () => {
  const min = 60_000;
  const t0 = 50_000_000;
  noteOpenSubtitlesDownload(null, true, t0);
  // The TV's Best match tried five files in a second at 18:55; at 19:33 its files were on top again.
  for (let i = 0; i < 5; i++) noteOpenSubtitlesDownload(503, false, t0 + i * 200);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 38 * min), true);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 239 * min), true);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 241 * min), false);
  for (let i = 0; i < 20; i++) noteOpenSubtitlesDownload(503, false, t0);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 359 * min), true);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 361 * min), false);
  noteOpenSubtitlesDownload(null, true, t0 + 1);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 2), false);
  // After a reset the next failure starts again at 15 minutes.
  noteOpenSubtitlesDownload(503, false, t0 + 3);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 14 * min), true);
  assert.equal(openSubtitlesDownloadsFailing(t0 + 16 * min), false);
});

// The 503s were our request (2026-11-13): OpenSubtitles answers POST /download and /login with an
// HTML "Error 503" page to axios's default Accept ("application/json, text/plain, */*"), and with a
// link to "application/json". Searches (GET) worked either way, so it looked like their outage.
test("every OpenSubtitles call asks for JSON only", () => {
  const h = openSubtitlesHeaders(undefined, "k");
  assert.equal(h.Accept, "application/json");
  assert.equal(h["Api-Key"], "k");
  assert.equal(openSubtitlesHeaders("tok", "k").Authorization, "Bearer tok");
});
