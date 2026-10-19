// Dependency-free mock Xtream Codes upstream (`/player_api.php`) generating a catalog at the
// scale of the owner's real portal (measured 2026-10): ~10k live channels, ~85k movies over
// 60 categories, ~10k series over 40 categories and ~54 EPG programmes per channel
// (~550k programmes total). Everything is derived from a seeded PRNG, so two runs (before /
// after a change) see byte-identical catalogs.
//
// Usage: `node scripts/bench/mockXtream.mjs [port]` (standalone), or import { startMock }.
import http from "node:http";

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "night dark star last city lost king queen river storm fire ice shadow blood moon sun " +
  "silent broken golden secret wild iron black white red blue green ghost dream love war " +
  "heart road home house island ocean mountain forest desert empire legend hunter killer " +
  "angel devil saint sinner hero rebel stranger soldier pilot doctor detective agent spy " +
  "thief prince princess warrior wolf tiger dragon eagle snake lion bear fox raven crow " +
  "winter summer spring autumn morning midnight evening tomorrow yesterday forever never " +
  "edge line point zero one two three seven ten hundred thousand million first final " +
  "return rise fall escape chase hunt run fight battle game trap code signal mission " +
  "project protocol theory paradox system machine robot planet galaxy space time world " +
  "earth sky rain snow wind thunder lightning fury rage glory honor justice vengeance " +
  "mercy grace hope faith fear terror horror mystery crime murder heist deal money gold " +
  "diamond silver crown throne sword shield arrow bullet gun knife bomb fuse spark flame"
).split(/\s+/).filter(Boolean);

const COUNTRIES = ["US", "UK", "IN", "CA", "DE", "FR", "ES", "IT", "AR", "PK", "BD", "NL", "PT", "TR", "BR"];
const CHANNEL_SUFFIX = ["", " HD", " FHD", " 4K", " SD", " +1"];

function titleFrom(rnd, minW, maxW) {
  const n = minW + Math.floor(rnd() * (maxW - minW + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)];
    out.push(w[0].toUpperCase() + w.slice(1));
  }
  return out.join(" ");
}

/** Split `total` items over `n` buckets with a skewed (Zipf-ish) distribution, deterministic. */
function skewedCounts(total, n, rnd) {
  const weights = Array.from({ length: n }, (_, i) => (1 / (i + 1) ** 0.6) * (0.75 + rnd() * 0.5));
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.floor((w / sum) * total));
  let left = total - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % n, left--) counts[i]++;
  return counts;
}

export const SCALE = {
  liveChannels: 10171,
  liveCategories: 150,
  movies: 85428,
  movieCategories: 60,
  series: 10000,
  seriesCategories: 40,
  epgPerChannel: 54,
};

export function buildCatalog(scale = SCALE, seed = 0xc0ffee, baseUrl = "http://127.0.0.1:18081") {
  const rnd = prng(seed);
  const added0 = 1700000000;

  // ── Live ────────────────────────────────────────────────────────────────
  const liveCategories = Array.from({ length: scale.liveCategories }, (_, i) => ({
    category_id: String(1 + i),
    category_name: `${COUNTRIES[i % COUNTRIES.length]}| ${titleFrom(rnd, 1, 2)}`,
    parent_id: 0,
  }));
  const liveCounts = skewedCounts(scale.liveChannels, scale.liveCategories, rnd);
  const liveStreams = [];
  let sid = 1;
  liveCounts.forEach((count, ci) => {
    for (let k = 0; k < count; k++, sid++) {
      const cc = COUNTRIES[ci % COUNTRIES.length];
      liveStreams.push({
        num: sid,
        name: `${cc}: ${titleFrom(rnd, 1, 3)}${CHANNEL_SUFFIX[Math.floor(rnd() * CHANNEL_SUFFIX.length)]}`,
        stream_type: "live",
        stream_id: sid,
        stream_icon: `${baseUrl}/logos/${sid}.png`,
        epg_channel_id: `ch${sid}.${cc.toLowerCase()}`,
        added: String(added0 + sid * 37),
        category_id: liveCategories[ci].category_id,
        custom_sid: "",
        tv_archive: 0,
        direct_source: "",
        tv_archive_duration: 0,
      });
    }
  });

  // ── VOD ─────────────────────────────────────────────────────────────────
  const vodCategories = Array.from({ length: scale.movieCategories }, (_, i) => ({
    category_id: String(1000 + i),
    category_name: `${COUNTRIES[i % COUNTRIES.length]} Movies ${titleFrom(rnd, 1, 1)}`,
    parent_id: 0,
  }));
  const vodByCat = new Map();
  const vodCounts = skewedCounts(scale.movies, scale.movieCategories, rnd);
  let vid = 100000;
  vodCounts.forEach((count, ci) => {
    const list = [];
    for (let k = 0; k < count; k++, vid++) {
      const year = 1960 + Math.floor(rnd() * 66);
      list.push({
        num: k + 1,
        name: `${titleFrom(rnd, 1, 4)} (${year})`,
        stream_type: "movie",
        stream_id: vid,
        stream_icon: `${baseUrl}/posters/${vid}.jpg`,
        rating: (rnd() * 10).toFixed(1),
        rating_5based: 0,
        added: String(added0 + vid),
        category_id: vodCategories[ci].category_id,
        container_extension: rnd() < 0.7 ? "mkv" : "mp4",
        custom_sid: "",
        direct_source: "",
      });
    }
    vodByCat.set(vodCategories[ci].category_id, list);
  });

  // ── Series ──────────────────────────────────────────────────────────────
  const seriesCategories = Array.from({ length: scale.seriesCategories }, (_, i) => ({
    category_id: String(2000 + i),
    category_name: `${COUNTRIES[i % COUNTRIES.length]} Series ${titleFrom(rnd, 1, 1)}`,
    parent_id: 0,
  }));
  const seriesByCat = new Map();
  const seriesCounts = skewedCounts(scale.series, scale.seriesCategories, rnd);
  let serid = 500000;
  seriesCounts.forEach((count, ci) => {
    const list = [];
    for (let k = 0; k < count; k++, serid++) {
      const year = 1980 + Math.floor(rnd() * 46);
      list.push({
        num: k + 1,
        name: `${titleFrom(rnd, 1, 3)} (${year})`,
        series_id: serid,
        cover: `${baseUrl}/covers/${serid}.jpg`,
        plot: `A ${WORDS[serid % WORDS.length]} story about ${titleFrom(rnd, 2, 5).toLowerCase()}.`,
        cast: `${titleFrom(rnd, 2, 2)}, ${titleFrom(rnd, 2, 2)}`,
        director: titleFrom(rnd, 2, 2),
        genre: "Drama",
        releaseDate: `${year}-01-01`,
        last_modified: String(added0 + serid),
        rating: (rnd() * 10).toFixed(1),
        category_id: seriesCategories[ci].category_id,
        backdrop_path: [],
        youtube_trailer: "",
        episode_run_time: "45",
      });
    }
    seriesByCat.set(seriesCategories[ci].category_id, list);
  });

  return { liveCategories, liveStreams, vodCategories, vodByCat, seriesCategories, seriesByCat };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const pad = (n) => String(n).padStart(2, "0");
const fmt = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** get_short_epg: `perChannel` programmes starting ~4 h before `anchorSec`, 15–60 min each. */
function shortEpg(streamId, anchorSec, perChannel) {
  const rnd = prng(0x5eed + Number(streamId) * 7919);
  let t = anchorSec - 4 * 3600 - Math.floor(rnd() * 1800);
  const listings = [];
  for (let i = 0; i < perChannel; i++) {
    const dur = (15 + Math.floor(rnd() * 4) * 15) * 60;
    const title = titleFrom(rnd, 1, 4);
    listings.push({
      id: String(streamId * 1000 + i),
      epg_id: String(streamId),
      title: b64(title),
      lang: "en",
      start: fmt(t),
      end: fmt(t + dur),
      description: b64(`${title}: episode ${i + 1}.`),
      channel_id: `ch${streamId}`,
      start_timestamp: String(t),
      stop_timestamp: String(t + dur),
    });
    t += dur;
  }
  return { epg_listings: listings };
}

export function startMock({ port = 18081, scale = SCALE, anchorSec } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const cat = buildCatalog(scale, 0xc0ffee, baseUrl);
  // Anchor the guide on the current hour so "now" falls inside it; programmes cover roughly
  // anchor-4h .. anchor+30h, so a DB built by `--setup` stays usable for a day of reruns.
  const anchor = anchorSec ?? Math.floor(Date.now() / 3600000) * 3600;
  const stats = { requests: 0, byAction: {}, lastAt: 0 };
  const allVod = () => [...cat.vodByCat.values()].flat();
  const allSeries = () => [...cat.seriesByCat.values()].flat();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, baseUrl);
    stats.requests++;
    stats.lastAt = Date.now();
    if (url.pathname !== "/player_api.php") {
      res.writeHead(404).end();
      return;
    }
    const q = url.searchParams;
    const action = q.get("action") || "";
    stats.byAction[action] = (stats.byAction[action] || 0) + 1;
    let body;
    switch (action) {
      case "":
        body = {
          user_info: { auth: 1, status: "Active", exp_date: String(anchor + 365 * 86400), username: q.get("username") },
          server_info: { url: "127.0.0.1", port: String(port) },
        };
        break;
      case "get_live_categories": body = cat.liveCategories; break;
      case "get_live_streams": {
        const c = q.get("category_id");
        body = c ? cat.liveStreams.filter((s) => s.category_id === c) : cat.liveStreams;
        break;
      }
      case "get_vod_categories": body = cat.vodCategories; break;
      case "get_vod_streams": {
        const c = q.get("category_id");
        body = c ? cat.vodByCat.get(c) ?? [] : allVod();
        break;
      }
      case "get_series_categories": body = cat.seriesCategories; break;
      case "get_series": {
        const c = q.get("category_id");
        body = c ? cat.seriesByCat.get(c) ?? [] : allSeries();
        break;
      }
      case "get_short_epg": body = shortEpg(q.get("stream_id"), anchor, scale.epgPerChannel); break;
      case "get_vod_info": body = { info: {}, movie_data: { stream_id: Number(q.get("vod_id")), container_extension: "mkv" } }; break;
      case "get_series_info": body = { info: {}, episodes: {}, seasons: [] }; break;
      default: body = [];
    }
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": buf.length });
    res.end(buf);
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, catalog: cat, stats, anchor, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/bench/mockXtream.mjs")) {
  const port = Number(process.argv[2]) || 18081;
  startMock({ port }).then(({ catalog }) => {
    const movies = [...catalog.vodByCat.values()].reduce((a, l) => a + l.length, 0);
    const series = [...catalog.seriesByCat.values()].reduce((a, l) => a + l.length, 0);
    console.log(`mock Xtream on :${port} — ${catalog.liveStreams.length} channels, ${movies} movies, ${series} series`);
  });
}
