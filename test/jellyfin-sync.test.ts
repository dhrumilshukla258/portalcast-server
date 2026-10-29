// Jellyfin as the library source (content/library/jellyfin.ts, jellyfinSync.ts), against a
// stand-in Jellyfin: libraries appear, a folder-library file is taken over with its ids, a
// re-created Jellyfin item keeps them, an unreachable Jellyfin removes nothing, and streams,
// playlists and artwork are relayed without the Jellyfin address or key reaching the client.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JELLYFIN_URL = "http://jf.test:8096";
process.env.JELLYFIN_API_KEY = "secret-key-123";

const LIB_MOVIES = "a".repeat(32);
const LIB_SHOWS = "b".repeat(32);
const HEAT = "1".repeat(32);
const HEAT_SRC = "2".repeat(32);
const ARRIVAL = "3".repeat(32);
const ARR_4K = "4".repeat(32);
const ARR_HD = "5".repeat(32);
const DARK = "6".repeat(32);
const DARK_E1 = "7".repeat(32);
const DARK_E1_SRC = "8".repeat(32);
const HEAT_NEW = "9".repeat(32);

const video = (codec: string, w: number, h: number) => ({ Type: "Video", Codec: codec, Index: 0, Width: w, Height: h, VideoRangeType: "SDR" });
let heatId = HEAT;
let down = false;
const seen: { url: string; headers: Record<string, string> }[] = [];

const jfItems: Record<string, any[]> = {
  Movie: [],
  Series: [{ Id: DARK, Name: "Dark", Type: "Series", ProductionYear: 2017, ProviderIds: { Tmdb: "70523" }, ImageTags: { Primary: "p" } }],
  Episode: [
    { Id: DARK_E1, Name: "Secrets", Type: "Episode", SeriesId: DARK, ParentIndexNumber: 1, IndexNumber: 1, ImageTags: { Primary: "still1" },
      MediaSources: [{ Id: DARK_E1_SRC, Path: "/data/shows/Dark/Season 1/Dark S01E01.mkv", Container: "mkv", Size: 5, MediaStreams: [video("h264", 1920, 1080)] }] },
    { Id: "c".repeat(32), Name: "Extra", Type: "Episode", SeriesId: DARK, MediaSources: [{ Id: "d".repeat(32), Path: "/x.mkv" }] }, // no number: left out
  ],
};
const movies = () => [
  { Id: heatId, Name: "Heat", Type: "Movie", ProductionYear: 1995, Overview: "A heist.", ProviderIds: { Tmdb: "949", Imdb: "tt0113277" },
    Genres: ["Crime"], People: [{ Name: "Al Pacino", Role: "Hanna", Type: "Actor" }, { Name: "Michael Mann", Type: "Director" }],
    ImageTags: { Primary: "poster1", Logo: "logo1" }, BackdropImageTags: ["bd1"],
    MediaSources: [{ Id: HEAT_SRC, Path: "/data/movies/Heat (1995)/Heat (1995).mkv", Container: "mkv", Size: 1000, RunTimeTicks: 102_000_000_000,
      MediaStreams: [video("h264", 1920, 800), { Type: "Audio", Codec: "ac3", Language: "eng", Index: 1, IsDefault: true, Channels: 6 },
        { Type: "Subtitle", Codec: "subrip", Language: "eng", Index: 2 }, { Type: "Subtitle", Codec: "srt", Language: "fre", Index: 3, IsExternal: true }] }] },
  { Id: ARRIVAL, Name: "Arrival", Type: "Movie", ProductionYear: 2016, ProviderIds: { Tmdb: "329865" },
    MediaSources: [
      { Id: ARR_4K, Name: "2160p", Path: "/data/movies/Arrival (2016)/Arrival (2016) - 2160p.mkv", Container: "mkv", Size: 9, MediaStreams: [video("hevc", 3840, 2160)] },
      { Id: ARR_HD, Name: "1080p", Path: "/data/movies/Arrival (2016)/Arrival (2016) - 1080p.mp4", Container: "mp4", Size: 3, MediaStreams: [video("h264", 1920, 1080), { Type: "Audio", Codec: "aac", Index: 1 }] },
    ] },
];

async function fakeJellyfin(input: any, init: any): Promise<Response> {
  const url = String(input);
  seen.push({ url, headers: init?.headers ?? {} });
  if (down) throw new Error("connect ECONNREFUSED");
  const u = new URL(url);
  if (u.pathname === "/Library/VirtualFolders") {
    return Response.json([
      { Name: "Movies", ItemId: LIB_MOVIES, CollectionType: "movies" },
      { Name: "Shows", ItemId: LIB_SHOWS, CollectionType: "tvshows" },
      { Name: "Music", ItemId: "e".repeat(32), CollectionType: "music" },
    ]);
  }
  if (u.pathname === "/System/Info") return Response.json({ ServerName: "Den", Version: "10.10.7" });
  if (u.pathname === "/Items") {
    const type = u.searchParams.get("IncludeItemTypes")!;
    const list = type === "Movie" ? movies() : jfItems[type];
    return Response.json({ Items: Number(u.searchParams.get("StartIndex")) > 0 ? [] : list, TotalRecordCount: list.length });
  }
  if (u.pathname.endsWith("/stream")) {
    const range = init?.headers?.Range;
    return new Response("0123456789".slice(0, range ? 4 : 10), {
      status: range ? 206 : 200,
      headers: { "content-type": "video/x-matroska", "content-length": range ? "4" : "10", ...(range ? { "content-range": "bytes 0-3/10" } : {}), "accept-ranges": "bytes" },
    });
  }
  if (u.pathname.endsWith("/master.m3u8")) {
    return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?DeviceId=portalcast-server&MediaSourceId=x\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  }
  if (u.pathname.endsWith("/main.m3u8")) {
    return new Response("#EXTM3U\n#EXTINF:6,\nhls1/main/0.ts?DeviceId=portalcast-server\n#EXTINF:6,\nhttp://evil.test/x.ts\n#EXT-X-ENDLIST\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  }
  if (u.pathname.includes("/hls1/main/0.ts")) return new Response("TS", { headers: { "content-type": "video/mp2t" } });
  if (u.pathname.includes("/Images/")) return new Response("IMG", { headers: { "content-type": "image/jpeg" } });
  return new Response("nope", { status: 404 });
}

test("Jellyfin libraries become My Library, taking over folder-library files with their ids", async () => {
  const { initDB } = await import("../src/db");
  const { loadSettings } = await import("../src/config/settings");
  await initDB();
  await loadSettings();
  const { setJellyfinTransport, needsJellyfinTranscode } = await import("../src/content/library/jellyfin");
  setJellyfinTransport(fakeJellyfin as any);
  const { Library } = await import("../src/models/Library");
  const { LocalItem } = await import("../src/models/LocalItem");
  const { MediaFile } = await import("../src/models/MediaFile");
  const { ContentMeta } = await import("../src/models/ContentMeta");
  const { scanLibraries } = await import("../src/content/library/scanner");

  // The folder library as it was: Heat, scanned from /media/movies.
  const folderLib = await Library.create({ name: "NAS movies", kind: "movies", folders: ["/media/movies"], enabled: true });
  const oldItem = await LocalItem.create({ libraryId: folderLib.id, kind: "movie", root: "/media/movies", relPath: "Heat (1995)", name: "Heat", year: "1995", missingSince: null });
  const oldFile = await MediaFile.create({ itemId: oldItem.id, libraryId: folderLib.id, root: "/media/movies", relPath: "Heat (1995)/Heat (1995).mkv", size: 1000, mtimeMs: 1, missingSince: null });

  const summary = await scanLibraries();
  assert.match(summary, /NAS movies: not scanned: Jellyfin is connected/);
  assert.match(summary, /Movies: 2 titles, 1 new, 1 taken over/);

  const libs = await Library.findAll({ where: { source: "jellyfin" }, order: [["id", "ASC"]] });
  assert.deepEqual(libs.map((l) => [l.name, l.kind]), [["Movies", "movies"], ["Shows", "series"]]); // music left out

  // Heat kept its title id and file id: progress, My List and cards stay.
  const heat = await LocalItem.findByPk(oldItem.id);
  assert.equal(heat!.root, "jellyfin");
  assert.equal(heat!.relPath, HEAT);
  assert.equal(heat!.tmdbIdHint, 949);
  assert.deepEqual(heat!.art, { poster: "Primary", backdrop: "Backdrop", logo: "Logo", v: heat!.art!.v });
  const heatFile = await MediaFile.findByPk(oldFile.id);
  assert.equal(heatFile!.relPath, `${HEAT}/${HEAT_SRC}`);
  assert.equal(heatFile!.remotePath, "/data/movies/Heat (1995)/Heat (1995).mkv");
  assert.equal(heatFile!.height, 800);
  assert.equal(Math.round(heatFile!.duration!), 10200);
  assert.deepEqual(heatFile!.audioTracks!.map((t) => [t.codec, t.language, t.default]), [["ac3", "eng", true]]);
  assert.deepEqual(heatFile!.subtitleTracks!.map((t) => t.index), [2]);
  assert.deepEqual(heatFile!.sidecars, [{ relPath: "jf:3", language: "fre", forced: false, format: "srt" }]);
  // Jellyfin's metadata through the NFO pass, and its artwork on the card.
  const meta = await ContentMeta.findByPk(`movie_L${oldItem.id}`);
  assert.equal(meta!.overview, "A heist.");
  assert.equal(meta!.director, "Michael Mann");
  assert.match(String(meta!.poster), new RegExp(`^local-art:${oldItem.id}:poster:`));

  // Arrival: two versions, labelled as Jellyfin names them.
  const arrival = await LocalItem.findOne({ where: { relPath: ARRIVAL } });
  const versions = await MediaFile.findAll({ where: { itemId: arrival!.id }, order: [["height", "DESC"]] });
  assert.deepEqual(versions.map((v) => v.versionLabel), ["2160p", "1080p"]);

  // Dark: the numbered episode, with its season, title and Jellyfin still.
  const dark = await LocalItem.findOne({ where: { relPath: DARK } });
  const eps = await MediaFile.findAll({ where: { itemId: dark!.id } });
  assert.deepEqual(eps.map((e) => [e.season, e.episode, e.episodeTitle, e.thumb]), [[1, 1, "Secrets", "jellyfin"]]);

  // Every request carried the key in a header, never in the address.
  assert.ok(seen.length > 0 && seen.every((r) => !r.url.includes("secret-key-123") && String(r.headers.Authorization).includes('Token="secret-key-123"')));

  // Jellyfin re-created Heat (new id, same file): the same rows again.
  heatId = HEAT_NEW;
  assert.match(await scanLibraries(), /Movies: 2 titles, 0 new, 0 matched/);
  const again = await MediaFile.findByPk(oldFile.id);
  assert.equal(again!.relPath, `${HEAT_NEW}/${HEAT_SRC}`);
  assert.equal(again!.missingSince, null);
  assert.equal((await LocalItem.findByPk(oldItem.id))!.relPath, HEAT_NEW);

  // Both have details: Jellyfin's win, TMDB's fill what Jellyfin lacks (no tagline in Jellyfin).
  await ContentMeta.update({ overview: "From TMDB.", tagline: "TMDB tagline" } as any, { where: { id: `movie_L${oldItem.id}` } });
  await scanLibraries();
  const merged = await ContentMeta.findByPk(`movie_L${oldItem.id}`);
  assert.equal(merged!.overview, "A heist.");
  assert.equal(merged!.tagline, "TMDB tagline");

  // Jellyfin unreachable: nothing is marked missing.
  down = true;
  const offline = await scanLibraries();
  assert.match(offline, /not reachable/);
  assert.equal((await MediaFile.count({ where: { missingSince: { [(await import("sequelize")).Op.ne]: null } } })), 0);
  down = false;

  // Play links: the browser gets Jellyfin's transcode for AC3 audio, the TV the file itself.
  const { localPlayLink } = await import("../src/content/library/catalog");
  assert.match(String(await localPlayLink(`LF${oldFile.id}`, "u", "Heat", "web")), /^\/api\/local\/jf\/master\.m3u8\?t=\w+&m3u8=1$/);
  assert.match(String(await localPlayLink(`LF${oldFile.id}`, "u", "Heat")), /^\/api\/local\/stream\?t=\w+$/);
  assert.equal(needsJellyfinTranscode({ videoCodec: "h264", container: "mp4", audioTracks: [{ index: 1, codec: "aac" }] }), false);
  assert.equal(needsJellyfinTranscode({ videoCodec: "hevc", container: "mkv", audioTracks: [] }), true);

  // Through the routes: relayed, range passed on, playlists pointing back here only.
  const Hapi = await import("@hapi/hapi");
  const { localStreamRoutes } = await import("../src/routes/library/stream");
  const server = Hapi.server();
  server.route(localStreamRoutes);
  const link = String(await localPlayLink(`LF${oldFile.id}`, "u", "Heat"));
  const ranged = await server.inject({ method: "GET", url: link, headers: { range: "bytes=0-3" } });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.payload, "0123");
  assert.equal(ranged.headers["content-range"], "bytes 0-3/10");
  assert.ok(seen.some((r) => r.url === `http://jf.test:8096/Videos/${HEAT_NEW}/stream?static=true&mediaSourceId=${HEAT_SRC}`));

  const hls = String(await localPlayLink(`LF${oldFile.id}`, "u", "Heat", "web"));
  const master = await server.inject({ method: "GET", url: hls });
  assert.equal(master.statusCode, 200);
  assert.doesNotMatch(master.payload, /jf\.test|secret/);
  const childUri = master.payload.split("\n").find((l) => l.startsWith("part?"))!;
  const child = await server.inject({ method: "GET", url: `/api/local/jf/${childUri}` });
  const lines = child.payload.split("\n");
  assert.ok(lines.some((l) => l.startsWith("part?") && l.includes(encodeURIComponent("hls1/main/0.ts"))));
  assert.ok(!child.payload.includes("evil.test")); // an absolute address is never relayed
  const seg = await server.inject({ method: "GET", url: `/api/local/jf/${lines.find((l) => l.startsWith("part?"))}` });
  assert.equal(seg.payload, "TS");
  const sneaky = await server.inject({ method: "GET", url: `${hls.replace("master.m3u8", "part")}&p=${encodeURIComponent("../../Users")}` });
  assert.equal(sneaky.statusCode, 404);

  // Artwork: the signed URL relays Jellyfin's image, scaled by Jellyfin.
  const { artUrl } = await import("../src/content/library/art");
  const img = await server.inject({ method: "GET", url: `${artUrl(String(meta!.poster))}&w=342` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.payload, "IMG");
  assert.ok(seen.some((r) => r.url === `http://jf.test:8096/Items/${HEAT_NEW}/Images/Primary?maxWidth=342&quality=90`));
  setJellyfinTransport(null);
});
