// OpenSubtitles' files go last while its downloads fail (content/opensubtitles.ts): on
// 2026-11-04 its download endpoint answered 503 for hours while search worked, and each top
// result failed in turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadableFirst, noteOpenSubtitlesDownload, openSubtitlesDownloadsFailing } from "../src/content/opensubtitles";

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
