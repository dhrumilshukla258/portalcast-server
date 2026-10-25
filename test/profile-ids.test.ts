// Profiles' ids in their own ranges (providers/profileIds.ts, config/profileSlots.ts): the first
// profile keeps the portal's ids, another profile's come out moved and go back in as the
// portal's, and two profiles with the same portal ids never share one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedId, portalId, slotOfId, scopeProvider, SLOT_SPAN, MAX_SLOT } from "../src/providers/profileIds";
import { initialConfig } from "../src/config/server";

test("ids: moved and back, types kept, slot 0 and odd ids unchanged", () => {
  assert.equal(scopedId(5001, 0), 5001);
  assert.equal(scopedId("5001", 0), "5001");
  assert.equal(scopedId(5001, 2), 2 * SLOT_SPAN + 5001);
  assert.equal(scopedId("5001", 2), String(2 * SLOT_SPAN + 5001));
  assert.equal(portalId(scopedId(5001, 2), 2), 5001);
  assert.equal(portalId(scopedId("5001", 2), 2), "5001");
  for (const odd of ["*", "0", 0, "", "12345:2", "L12", "0012", -4, 1.5, null, undefined]) {
    assert.equal(scopedId(odd as any, 3), odd, `scopedId(${String(odd)})`);
    assert.equal(portalId(odd as any, 3), odd, `portalId(${String(odd)})`);
  }
  // Another range's id, or a portal id, goes in as it is.
  assert.equal(portalId(scopedId(77, 1), 2), scopedId(77, 1));
  assert.equal(portalId(77, 2), 77);
  // The largest M3U id in the last range is still a safe integer and comes back exactly.
  const big = SLOT_SPAN - 1;
  const moved = scopedId(big, MAX_SLOT);
  assert.ok(Number.isSafeInteger(moved));
  assert.equal(portalId(moved, MAX_SLOT), big);
  assert.equal(portalId(String(moved), MAX_SLOT), String(big));
  assert.equal(slotOfId(String(moved)), MAX_SLOT);
  assert.equal(slotOfId(5001), 0);
  // Ids at or past the range size are not portal ids we can move.
  assert.equal(scopedId(SLOT_SPAN, 1), SLOT_SPAN);
});

const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="news.one" group-title="News",News One
http://host.example:8080/live/u/p/101.ts
#EXTINF:-1 group-title="Action",The Matrix (1999)
http://host.example:8080/movie/u/p/5001.mkv
#EXTINF:-1 group-title="Drama",Breaking Bad S01E01
http://host.example:8080/series/u/p/7001.mp4
#EXTINF:-1 group-title="Drama",Breaking Bad S01E02
http://host.example:8080/series/u/p/7002.mp4
`;

test("provider: a second profile's answers are moved, its requests reach the portal as the portal's ids", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = (s: number) => new Date(s * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
  const guide = `<tv><programme start="${t(now - 600)}" stop="${t(now + 600)}" channel="news.one"><title>Now on News</title></programme></tv>`;
  Object.assign(initialConfig, {
    providerType: "m3u",
    m3uUrl: "data:text/plain;base64," + Buffer.from(PLAYLIST).toString("base64"),
    xmltvUrl: "data:text/xml;base64," + Buffer.from(guide).toString("base64"),
  });
  const { M3uProvider } = await import("../src/providers/m3u/provider");
  const inner = new M3uProvider();
  assert.equal(scopeProvider(inner, 0), inner);
  const slot = 3;
  const p = scopeProvider(inner, slot);
  const lo = slot * SLOT_SPAN, hi = (slot + 1) * SLOT_SPAN;
  const inRange = (id: any) => Number(id) >= lo && Number(id) < hi;

  // Live: groups, channels and their group, the guide by the moved id.
  const groups = (await p.getChannelGroups()).js;
  assert.ok(groups.length > 0 && groups.every((g) => inRange(g.id)));
  const ch = (await p.getChannels()).js.data[0];
  assert.ok(inRange(ch.id) && inRange(ch.tv_genre_id));
  assert.equal(ch.tv_genre_id, groups[0].id);
  assert.equal(ch.cmd, "http://host.example:8080/live/u/p/101.ts");
  assert.equal((await p.getEPG(ch.id)).js[0]?.name, "Now on News");

  // Movies: category, list, link.
  const action = (await p.getMoviesGroups()).js.find((g) => g.title === "Action")!;
  assert.ok(inRange(action.id));
  const movies = (await p.getMovies({ category: action.id, page: 1 })).js.data;
  assert.deepEqual(movies.map((m) => m.name), ["The Matrix (1999)"]);
  assert.ok(inRange(movies[0].id) && movies[0].category_id === action.id);
  assert.equal(portalId(movies[0].id, slot), (await inner.getMovies({ category: portalId(action.id, slot), page: 1 })).js.data[0].id);
  assert.equal((await p.getMovieLink({ id: movies[0].id as any, series: "0", download: 0 })).js.cmd, "http://host.example:8080/movie/u/p/5001.mkv");

  // Series: list, seasons, episodes, an episode's link.
  const show = (await p.getSeries({ category: "*", page: 1 })).js.data.find((s) => s.name === "Breaking Bad")!;
  assert.ok(inRange(show.id));
  const seasons = (await p.getSeries({ category: "*", page: 1, movieId: show.id as any })).js.data;
  assert.deepEqual(seasons.map((s) => s.name), ["Season 1"]);
  const eps = (await p.getSeries({ category: "*", page: 1, movieId: show.id as any, seasonId: seasons[0].id as any })).js.data;
  assert.deepEqual(eps.map((e) => e.episode_number), [1, 2]);
  assert.ok(eps.every((e) => inRange(e.id)));
  assert.equal((await p.getSeriesLink({ series: String(show.id), id: eps[1].id as any, download: 0 })).js.cmd, "http://host.example:8080/series/u/p/7002.mp4");

  // The same portal as the first profile: not one id in common.
  const firstIds = new Set([
    ...(await inner.getMoviesGroups()).js.map((g) => String(g.id)),
    ...(await inner.getMovies({ category: "*", page: 1 })).js.data.map((m) => String(m.id)),
  ]);
  const secondIds = [
    ...(await p.getMoviesGroups()).js.map((g) => String(g.id)),
    ...(await p.getMovies({ category: "*", page: 1 })).js.data.map((m) => String(m.id)),
  ];
  assert.ok(secondIds.length > 0 && secondIds.every((id) => !firstIds.has(id)));

  // Everything else is the provider's own.
  assert.equal(p.localGuide, true);
  assert.equal(typeof p.isIdle(), "boolean");
  p.clearCache();
});

test("slots: the first active profile keeps the portal's ids, the next ones take new ranges, never given twice", async () => {
  const { sequelize } = await import("../src/db/index");
  const { SystemConfig } = await import("../src/models/SystemConfig");
  const { Channel } = await import("../src/models/Channel");
  const { Genre } = await import("../src/models/Genre");
  const { EpgCache } = await import("../src/models/EpgCache");
  const { ContentCache } = await import("../src/models/ContentCache");
  for (const m of [SystemConfig, Channel, Genre, EpgCache, ContentCache]) await (m as any).sync();
  const { slotFor } = await import("../src/config/profileSlots");

  assert.equal(await slotFor(7), 0);
  // Profile 9 already had categories stored with the portal's ids, and a guide-skip list.
  await Genre.create({ id: "9_movie_12", title: "Old", number: 1, alias: "", censored: 0, type: "movie", profileId: 9 } as any);
  await Genre.create({ id: "7_movie_12", title: "Mine", number: 1, alias: "", censored: 0, type: "movie", profileId: 7 } as any);
  await SystemConfig.upsert({ key: "epg_empty_9", value: { a: [2, 0] } });
  assert.equal(await slotFor(9), 1);
  assert.equal(await Genre.count({ where: { profileId: 9 } }), 0);
  assert.equal(await Genre.count({ where: { profileId: 7 } }), 1);
  assert.equal(await SystemConfig.findByPk("epg_empty_9"), null);
  // Asked again: the same range, and nothing dropped this time.
  await Genre.create({ id: "9_movie_" + scopedId("12", 1), title: "New", number: 1, alias: "", censored: 0, type: "movie", profileId: 9 } as any);
  assert.equal(await slotFor(9), 1);
  assert.equal(await Genre.count({ where: { profileId: 9 } }), 1);
  assert.equal(await slotFor(7), 0);
  assert.equal(await slotFor(4), 2);
  assert.deepEqual((await SystemConfig.findByPk("profile_id_slots"))!.value, { 7: 0, 9: 1, 4: 2 });
  // All ranges given: a clear refusal, nothing stored.
  const full: Record<string, number> = {};
  for (let s = 0; s <= MAX_SLOT; s++) full[String(100 + s)] = s;
  await SystemConfig.upsert({ key: "profile_id_slots", value: full });
  await assert.rejects(slotFor(500), /id ranges/);
  assert.deepEqual((await SystemConfig.findByPk("profile_id_slots"))!.value, full);
  await sequelize.close();
});
