// Gestdown (content/gestdown.ts), the keyless episode-subtitle source, with a stand-in API:
// the show is found by name, only episodes are searched, and its subtitles download through
// /api/v2/subtitles/download as WebVTT; a malformed id is refused.
import { test } from "node:test";
import assert from "node:assert/strict";

const DARK = "2PXkmzotvvtLoBsoILLxfe";
const SUB = "1ieAyo2AF5ej7Gvgj9t5kb";
const asked: string[] = [];

async function standIn(url: string) {
  asked.push(url);
  if (url.includes("/shows/search/")) {
    return { status: 200, data: { shows: [{ id: "0DiDlE0dP6t4NVfpLwKfk9", name: "Are You Afraid of the Dark (2019)" }, { id: DARK, name: "Dark" }] } };
  }
  if (url.includes(`/subtitles/get/${DARK}/1/1/French`)) {
    return { status: 200, data: { episode: { show: "Dark" }, matchingSubtitles: [
      { subtitleId: SUB, version: "WEBRip.x264-STRiFE", completed: true, downloadCount: 531 },
      { subtitleId: "aaaaaaaaaaaaaaaaaaaaaa", version: "partial", completed: false, downloadCount: 900 },
    ] } };
  }
  if (url.endsWith(`/subtitles/download/${SUB}`)) return { status: 200, data: "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n" };
  return { status: 404, data: {} };
}

test("Gestdown: episode subtitles by show name, downloaded as WebVTT", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("axios").get = standIn;
  (await import("axios")).default.get = standIn as any;
  const { searchGestdown } = await import("../src/content/gestdown");

  assert.deepEqual(await searchGestdown({ title: "Heat", year: "1995" }), []); // a film: not asked at all
  assert.equal(asked.length, 0);

  const found = await searchGestdown({ title: "Dark", season: 1, episode: 1, language: "fr" });
  assert.deepEqual(found.map((r) => [r.downloadId, r.source, r.releaseName]), [[`gd:${SUB}`, "gestdown", "Dark · WEBRip.x264-STRiFE"]]); // the unfinished one left out

  const { initDB } = await import("../src/db");
  await initDB();
  const Hapi = await import("@hapi/hapi");
  const { subtitleRoutes } = await import("../src/routes/stalkerV2/subtitles");
  const server = Hapi.server();
  server.route(subtitleRoutes);
  const ok = await server.inject({ method: "GET", url: `/api/v2/subtitles/download?id=gd:${SUB}` });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.payload, /^WEBVTT[\s\S]*Bonjour/);
  const bad = await server.inject({ method: "GET", url: `/api/v2/subtitles/download?id=${encodeURIComponent("gd:../../x")}` });
  assert.equal(bad.statusCode, 400);
});
