// M3U profiles (src/providers/m3u): the playlist parser, the library, the XMLTV reader, and the
// provider end to end (a data: link stands in for the playlist, so nothing leaves the machine).
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";
import { parseM3u, buildLibrary, kindOf, episodeOf, idOf } from "../src/providers/m3u/parse";
import { XmltvReader, xmltvTime } from "../src/providers/m3u/xmltv";
import { initialConfig } from "../src/config/server";

const PLAYLIST = `﻿#EXTM3U url-tvg="http://guide.example/epg.xml.gz"
#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="http://img/bbc.png" group-title="UK | News",BBC One HD
http://host.example:8080/live/user/pass/101.ts
#EXTINF:-1 tvg-id="" tvg-logo="" group-title="UK | News",Sky News
#EXTVLCOPT:http-user-agent=VLC
http://host.example:8080/live/user/pass/102.m3u8
#EXTINF:-1 tvg-name="Sky News" group-title="UK | News",Sky News
http://host.example:8080/live/user/pass/103.m3u8
#EXTINF:-1 tvg-logo="http://img/m.jpg" group-title="VOD | Action",The Matrix (1999)
http://host.example:8080/movie/user/pass/5001.mkv
#EXTINF:-1 group-title="Films",Arrival 2016
http://cdn.example/files/arrival.mp4?token=abc
#EXTINF:-1 tvg-logo="http://img/s.jpg" group-title="Series | Drama",Breaking Bad S01 E02
http://host.example:8080/series/user/pass/7002.mp4
#EXTINF:-1 group-title="Series | Drama",Breaking Bad S01E01
http://host.example:8080/series/user/pass/7001.mp4
#EXTINF:-1 group-title="Series | Drama",Breaking Bad S02E01 - Seven Thirty-Seven
http://host.example:8080/series/user/pass/7010.mkv
#EXTINF:-1,Orphan without a group
http://host.example/stream
not-a-link
#EXTINF:-1 group-title="Broken",Has no link
#EXTINF:-1 group-title="Docs",The Office 3x05
http://cdn.example/office/s3e5.mkv
`;

test("entries: names, groups, logos, tvg attributes and the guide link", () => {
  const p = parseM3u(PLAYLIST.split("\n"));
  assert.equal(p.guideUrl, "http://guide.example/epg.xml.gz");
  assert.equal(p.entries.length, 10);
  const bbc = p.entries[0];
  assert.deepEqual([bbc.name, bbc.group, bbc.logo, bbc.tvgId, bbc.tvgName, bbc.kind], ["BBC One HD", "UK | News", "http://img/bbc.png", "bbc1.uk", "BBC One", "live"]);
  assert.equal(p.entries.find((e) => e.name === "Orphan without a group")!.group, "Uncategorized");
  // A broken entry (no link) is dropped, and does not eat the next one.
  assert.ok(!p.entries.some((e) => e.name === "Has no link"));
  assert.ok(p.entries.some((e) => e.name === "The Office 3x05"));
});

test("kinds: Xtream paths, tvg-type, file types and episode names", () => {
  const kinds = Object.fromEntries(parseM3u(PLAYLIST.split("\n")).entries.map((e) => [e.name, e.kind]));
  assert.equal(kinds["The Matrix (1999)"], "movie");
  assert.equal(kinds["Arrival 2016"], "movie");             // a video file, query string after
  assert.equal(kinds["Breaking Bad S01 E02"], "episode");    // /series/
  assert.equal(kinds["The Office 3x05"], "episode");         // a video file named 3x05
  assert.equal(kinds["Sky News"], "live");                   // .m3u8
  assert.equal(kindOf("http://x/stream", "movie", "Name", "G"), "movie");
  assert.equal(kindOf("http://x/a.mp4", "live", "Name", "G"), "live");
});

test("episode names: S01E02, S01 E02, 1x02, with titles after", () => {
  assert.deepEqual(episodeOf("Breaking Bad S01 E02"), ["Breaking Bad", 1, 2]);
  assert.deepEqual(episodeOf("Breaking Bad - S02E01 - Seven Thirty-Seven"), ["Breaking Bad", 2, 1]);
  assert.deepEqual(episodeOf("The Office 3x05"), ["The Office", 3, 5]);
  assert.equal(episodeOf("The Matrix (1999)"), null);
});

test("library: groups per kind, shows with sorted seasons, stable ids, duplicates kept apart", () => {
  const lib = buildLibrary(parseM3u(PLAYLIST.split("\n")));
  assert.deepEqual(lib.liveGroups.map((g) => g.title), ["UK | News", "Uncategorized"]);
  assert.deepEqual(lib.movieGroups.map((g) => g.title), ["VOD | Action", "Films"]);
  assert.equal(lib.channels.length, 4);
  // Two "Sky News" in one group: two channels, two ids.
  const sky = lib.channels.filter((c) => c.name === "Sky News");
  assert.equal(sky.length, 2);
  assert.notEqual(sky[0].id, sky[1].id);
  const bb = lib.shows.find((s) => s.name === "Breaking Bad")!;
  assert.deepEqual(Object.keys(bb.seasons), ["1", "2"]);
  assert.deepEqual(bb.seasons[1].map((e) => e.episode), [1, 2]);
  assert.equal(bb.logo, "http://img/s.jpg");
  // The same playlist again gives the same ids (they do not depend on the links).
  const again = buildLibrary(parseM3u(PLAYLIST.replace(/\/user\/pass\//g, "/u2/p2/").split("\n")));
  assert.deepEqual(again.channels.map((c) => c.id), lib.channels.map((c) => c.id));
  assert.deepEqual(again.movies.map((m) => m.id), lib.movies.map((m) => m.id));
  assert.ok(lib.movies.every((m) => /^\d+$/.test(m.id) && Number(m.id) < 2 ** 48));
  assert.equal(idOf("a"), idOf("a"));
});

test("XMLTV: times with offsets, the window, names, entities, duplicates, chunks split anywhere", () => {
  assert.equal(xmltvTime("20261024190000 +0100"), Date.UTC(2026, 9, 24, 18, 0, 0) / 1000);
  assert.equal(xmltvTime("20261024190000"), Date.UTC(2026, 9, 24, 19, 0, 0) / 1000);
  const now = Date.UTC(2026, 9, 24, 18, 30, 0) / 1000;
  const xml = `<?xml version="1.0"?><tv>
<channel id="bbc1.uk"><display-name>BBC One</display-name><display-name lang="en">BBC 1</display-name></channel>
<programme start="20261024180000 +0000" stop="20261024190000 +0000" channel="bbc1.uk"><title lang="en">News &amp; Weather</title></programme>
<programme start="20261024190000 +0000" stop="20261024200000 +0000" channel="bbc1.uk">
  <title>The One Show</title><desc>…</desc>
</programme>
<programme start="20261001000000 +0000" stop="20261001010000 +0000" channel="bbc1.uk"><title>Too old</title></programme>
<programme start="20261024190000 +0000" stop="20261024200000 +0000" channel="bbc1.uk"><title>The One Show</title></programme>
<programme start="20261024190000 +0000" stop="20261024200000 +0000" channel="sky"><title><![CDATA[Sky <Live>]]></title></programme>
</tv>`;
  const r = new XmltvReader(now);
  for (let i = 0; i < xml.length; i += 37) r.push(xml.slice(i, i + 37));
  const g = r.finish();
  assert.deepEqual(g.byChannel.get("bbc1.uk")!.map((p) => p.title), ["News & Weather", "The One Show"]);
  assert.equal(g.byChannel.get("sky")![0].title, "Sky <Live>");
  assert.equal(g.idByName.get("bbc 1"), "bbc1.uk");
});

test("provider: downloads the playlist and the gzipped guide, answers like Xtream", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = (s: number) => new Date(s * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
  const guide = `<tv><programme start="${t(now - 600)}" stop="${t(now + 600)}" channel="bbc1.uk"><title>Now on BBC</title></programme>
<programme start="${t(now - 600)}" stop="${t(now + 600)}" channel="skynews"><title>Now on Sky</title></programme>
<channel id="skynews"><display-name>Sky News</display-name></channel></tv>`;
  const gz = zlib.gzipSync(Buffer.from(guide)).toString("base64");
  Object.assign(initialConfig, {
    providerType: "m3u",
    m3uUrl: "data:text/plain;base64," + Buffer.from(PLAYLIST).toString("base64"),
    xmltvUrl: "data:application/gzip;base64," + gz,
  });
  const { M3uProvider } = await import("../src/providers/m3u/provider");
  const p = new M3uProvider();
  const groups = (await p.getChannelGroups()).js;
  assert.deepEqual(groups.map((g) => g.title), ["UK | News", "Uncategorized"]);
  const channels = (await p.getChannels()).js.data;
  assert.equal(channels.length, 4);
  assert.equal(channels[0].cmd, "http://host.example:8080/live/user/pass/101.ts");
  // Guide: by tvg-id, else by name.
  assert.equal((await p.getEPG(channels[0].id)).js[0]?.name, "Now on BBC");
  const sky = channels.find((c) => c.name === "Sky News")!;
  assert.equal((await p.getEPG(sky.id)).js[0]?.name, "Now on Sky");
  // Movies by category, a movie by id, its link.
  const action = (await p.getMoviesGroups()).js.find((g) => g.title === "VOD | Action")!;
  const movies = (await p.getMovies({ category: action.id, page: 1 })).js;
  assert.deepEqual(movies.data.map((m) => m.name), ["The Matrix (1999)"]);
  assert.equal((await p.getMovieLink({ id: movies.data[0].id as any })).js.cmd, "http://host.example:8080/movie/user/pass/5001.mkv");
  // Series: list, seasons, episodes, an episode's link and the apps' episode lookup.
  const shows = (await p.getSeries({ category: "*", page: 1 })).js.data;
  const bb = shows.find((s) => s.name === "Breaking Bad")!;
  const seasons = (await p.getSeries({ category: "*", page: 1, movieId: bb.id as any })).js.data;
  assert.deepEqual(seasons.map((s) => s.name), ["Season 1", "Season 2"]);
  const eps = (await p.getSeries({ category: "*", page: 1, movieId: bb.id as any, seasonId: 1 })).js.data;
  assert.deepEqual(eps.map((e) => e.episode_number), [1, 2]);
  assert.equal((await p.getSeriesLink({ series: String(bb.id), id: eps[1].id as any })).js.cmd, "http://host.example:8080/series/user/pass/7002.mp4");
  const lookup = (await p.getMovies({ category: "*", page: 1, movieId: bb.id as any, episodeId: eps[0].id as any })).js.data;
  assert.equal(lookup[0]?.cmd, "http://host.example:8080/series/user/pass/7001.mp4");
  assert.equal(p.localGuide, true);
});
