// The M3U provider (profile type "m3u"): a playlist link (and optionally an XMLTV guide link)
// instead of a portal. Answers in the Xtream client's shapes, so every route, the catalog warm,
// TMDB matching and both apps work unchanged; links are direct, like Xtream's.
//
// - The playlist is downloaded and read line by line (never held whole), parsed into a library
//   (parse.ts), kept in memory and saved under the data folder, so a restart serves at once.
//   Refreshed once a day (checked hourly); a failed download keeps the previous library.
// - The guide: the profile's XMLTV link, else the playlist's own url-tvg. Read as a stream,
//   6 h back to 2 days ahead (xmltv.ts), refreshed every 6 h. Channels match by tvg-id, then by
//   name. getEPG answers from memory, so the guide fetch needs no pacing (localGuide).
// - Links and the playlist URL can hold the account's username and password: they are never
//   logged (only the host), and the URL is stored encrypted with the profile.

import fs from "fs";
import path from "path";
import { Readable } from "stream";
import zlib from "zlib";
import { createHash } from "crypto";
import { IProvider } from "@/providers/Provider";
import { initialConfig } from "@/config/server";
import { logger } from "@/infra/logger";
import { dataDir } from "@/infra/paths";
import { buildLibrary, M3uParser, type M3uLibrary, type M3uShow } from "./parse";
import { XmltvReader, type Guide } from "./xmltv";
import type { ArrayData, Channel, Data, EPG_List, Genre, MoviesApiParams, Program, Programs, Video } from "@/types/domain";

const PAGE = 14;
const DAY = 24 * 3600_000;
const GUIDE_EVERY = 6 * 3600_000;
const MAX_PLAYLIST_BYTES = 512 * 1024 * 1024;
const MAX_GUIDE_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
// Many IPTV services answer only players they know.
const DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "?"; } };

/** Lines of a text download (gzip unpacked when the file is gzipped), streamed. */
async function* downloadLines(url: string, maxBytes: number): AsyncGenerator<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": initialConfig.userAgent || DEFAULT_UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    let stream: Readable = Readable.fromWeb(res.body as any);
    // A .gz file (often the XMLTV guide) is gzip whatever the headers say: peek at its magic.
    const head: Buffer = await new Promise((resolve, reject) => {
      stream.once("readable", () => { const b = stream.read(2) as Buffer | null; if (b) stream.unshift(b); resolve(b ?? Buffer.alloc(0)); });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.alloc(0)));
    });
    if (head.length === 2 && head[0] === 0x1f && head[1] === 0x8b) stream = stream.pipe(zlib.createGunzip());
    let bytes = 0, rest = "";
    stream.setEncoding("utf8");
    for await (const chunk of stream as AsyncIterable<string>) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`larger than ${Math.round(maxBytes / 1048576)} MB`);
      clearTimeout(timer);
      const text = rest + chunk;
      const lines = text.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const l of lines) yield l;
    }
    if (rest) yield rest;
  } finally {
    clearTimeout(timer);
  }
}

/** The playlist at `url`, parsed as it downloads (only the entries are kept). */
async function parseFrom(url: string) {
  const parser = new M3uParser();
  for await (const l of downloadLines(url, MAX_PLAYLIST_BYTES)) parser.push(l);
  return parser.finish();
}

/** Id -> item tables for a library (built once per library). */
interface Index {
  lib: M3uLibrary;
  channels: Map<string, M3uLibrary["channels"][number]>;
  movies: Map<string, M3uLibrary["movies"][number]>;
  shows: Map<string, M3uShow>;
  episodes: Map<string, [M3uShow, M3uShow["seasons"][number][number]]>;
}

function indexOf(lib: M3uLibrary): Index {
  const episodes = new Map<string, [M3uShow, M3uShow["seasons"][number][number]]>();
  for (const s of lib.shows) for (const eps of Object.values(s.seasons)) for (const e of eps) episodes.set(e.id, [s, e]);
  return {
    lib,
    channels: new Map(lib.channels.map((c) => [c.id, c])),
    movies: new Map(lib.movies.map((m) => [m.id, m])),
    shows: new Map(lib.shows.map((s) => [s.id, s])),
    episodes,
  };
}

export class M3uProvider implements IProvider {
  /** Its guide is read from a file in memory: the guide fetch needs no pacing. */
  readonly localGuide = true;
  private library: M3uLibrary | null = null;
  private index: Index | null = null;
  private loading: Promise<M3uLibrary | null> | null = null;
  private guide: Guide | null = null;
  private guideLoading: Promise<Guide | null> | null = null;
  private lastRequest = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly url: string;
  private readonly file: string;

  constructor() {
    this.url = String((initialConfig as any).m3uUrl || "").trim();
    const key = createHash("sha256").update(this.url).digest("hex").slice(0, 16);
    this.file = path.join(dataDir, "m3u", `library-${key}.json`);
    try {
      if (fs.existsSync(this.file)) this.library = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      logger.warn(`[m3u] saved playlist unreadable, downloading it again: ${e}`);
    }
    // Daily refresh, checked hourly; unref'd so it never keeps the process alive.
    this.timer = setInterval(() => { if (this.stale()) void this.refresh(); }, 3600_000);
    this.timer.unref?.();
  }

  /** The id tables of the current library (rebuilt when the library changes). */
  private idx_(): Index | null {
    if (!this.library) return null;
    if (this.index?.lib !== this.library) this.index = indexOf(this.library);
    return this.index;
  }

  private async idx(): Promise<Index | null> {
    await this.lib();
    return this.idx_();
  }

  private stale(): boolean { return !this.library || Date.now() - this.library.builtAt > DAY; }

  /** The library, downloading it the first time (or when a day old, in the background). */
  private async lib(): Promise<M3uLibrary | null> {
    this.lastRequest = Date.now();
    if (!this.library) return this.refresh();
    if (this.stale()) void this.refresh();
    return this.library;
  }

  refresh(): Promise<M3uLibrary | null> {
    if (this.loading) return this.loading;
    if (!this.url) { logger.warn("[m3u] the profile has no playlist link"); return Promise.resolve(this.library); }
    const t0 = Date.now();
    this.loading = (async () => {
      try {
        const parsed = await parseFrom(this.url);
        if (!parsed.entries.length) throw new Error("no entries (not an M3U playlist?)");
        const lib = buildLibrary(parsed);
        this.library = lib;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(lib));
        fs.renameSync(this.file + ".tmp", this.file);
        logger.info(`[m3u] playlist from ${hostOf(this.url)}: ${lib.channels.length} channels, ${lib.movies.length} movies, ${lib.shows.length} series in ${Date.now() - t0} ms`);
      } catch (e: any) {
        logger.error(`[m3u] playlist download from ${hostOf(this.url)} failed (keeping the previous one): ${e?.message ?? e}`);
      } finally {
        this.loading = null;
      }
      return this.library;
    })();
    return this.loading;
  }

  private guideUrl(): string | null {
    return String((initialConfig as any).xmltvUrl || "").trim() || this.library?.guideUrl || null;
  }

  private async loadGuide(): Promise<Guide | null> {
    if (this.guide && Date.now() - this.guide.builtAt < GUIDE_EVERY) return this.guide;
    if (this.guideLoading) return this.guideLoading;
    const url = this.guideUrl();
    if (!url) return null;
    const t0 = Date.now();
    this.guideLoading = (async () => {
      try {
        const reader = new XmltvReader();
        let batch = "";
        for await (const l of downloadLines(url, MAX_GUIDE_BYTES)) {
          batch += l + "\n";
          if (batch.length > 256 * 1024) { reader.push(batch); batch = ""; }
        }
        reader.push(batch);
        this.guide = reader.finish();
        logger.info(`[m3u] guide from ${hostOf(url)}: ${this.guide.byChannel.size} channels in ${Date.now() - t0} ms`);
      } catch (e: any) {
        logger.error(`[m3u] guide download from ${hostOf(url)} failed: ${e?.message ?? e}`);
      } finally {
        this.guideLoading = null;
      }
      return this.guide;
    })();
    return this.guideLoading;
  }

  // ---- IProvider -------------------------------------------------------------------------

  async getToken(): Promise<string | null> { return "m3u"; }
  async getExpiry(): Promise<string | null> { return null; }
  isIdle(thresholdMs = 30000): boolean { return Date.now() - this.lastRequest > thresholdMs; }
  clearCache(): void { /* the library is the cache; refresh() replaces it */ }

  private genres(list: { id: string; title: string }[]): Data<Genre[]> {
    return { js: list.map((g) => ({ id: g.id, title: g.title, number: 0, alias: g.title, censored: 0 })) };
  }

  async getChannelGroups(): Promise<Data<Genre[]>> {
    return this.genres((await this.lib())?.liveGroups ?? []);
  }

  async getChannels(): Promise<Data<Programs<Channel>>> {
    const data: Channel[] = ((await this.lib())?.channels ?? []).map((c) => ({
      id: c.id, name: c.name, cmd: c.url, number: c.number, logo: c.logo, tv_genre_id: c.groupId, censored: "0",
    }));
    return { js: { total_items: data.length, max_page_items: data.length, data } };
  }

  async getChannelLink(cmd: string): Promise<Data<Program>> {
    return { js: { id: "0", name: "", cmd } };
  }

  async getEPG(channelId: string): Promise<ArrayData<EPG_List>> {
    const ch = (await this.idx())?.channels.get(String(channelId));
    if (!ch) return { js: [] };
    const guide = await this.loadGuide();
    if (!guide) return { js: [] };
    const key = (ch.tvgId && guide.byChannel.has(ch.tvgId) ? ch.tvgId : null)
      ?? guide.idByName.get((ch.tvgName || ch.name).toLowerCase())
      ?? guide.idByName.get(ch.name.toLowerCase());
    const list = key ? guide.byChannel.get(key) ?? [] : [];
    return { js: list.map((p) => ({ start_timestamp: String(p.start), stop_timestamp: String(p.stop), name: p.title })) };
  }

  private page<T extends Program>(all: T[], params: MoviesApiParams): Data<Programs<T>> {
    let list = all;
    if (params.search) { const s = params.search.toLowerCase(); list = list.filter((v) => v.name.toLowerCase().includes(s)); }
    if (params.sort && /^(alphabetic|name)$/i.test(params.sort)) list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    const page = Number(params.page) || 1;
    return { js: { total_items: list.length, max_page_items: PAGE, data: list.slice((page - 1) * PAGE, page * PAGE) } };
  }

  async getMoviesGroups(): Promise<Data<Genre[]>> {
    return this.genres((await this.lib())?.movieGroups ?? []);
  }

  async getMovies(params: MoviesApiParams): Promise<Data<Programs<Video>>> {
    const lib = await this.lib();
    if (!lib) return { js: { total_items: 0, max_page_items: PAGE, data: [] } };
    // The apps' "resolve the episode file" call: movieId is then a series id.
    if (params.episodeId && params.movieId) {
      const ep = this.findEpisode(lib, String(params.movieId), String(params.episodeId));
      return { js: { total_items: ep ? 1 : 0, max_page_items: 1, data: ep ? [ep] : [] } };
    }
    const toVideo = (m: M3uLibrary["movies"][number]): Video => ({
      id: m.id, name: m.name, cmd: m.url, screenshot_uri: m.logo, category_id: m.groupId, time: 0, rating_imdb: "0",
    });
    if (params.movieId) {
      const m = this.idx_()?.movies.get(String(params.movieId));
      return { js: { total_items: m ? 1 : 0, max_page_items: 1, data: m ? [toVideo(m)] : [] } };
    }
    const cat = params.category && params.category !== "*" && params.category !== "0" ? String(params.category) : null;
    return this.page((cat ? lib.movies.filter((m) => m.groupId === cat) : lib.movies).map(toVideo), params);
  }

  async getMovieLink(params: { id: number | string }): Promise<any> {
    const m = (await this.idx())?.movies.get(String(params.id));
    return { js: { cmd: m?.url ?? "" } };
  }

  async getVodLinkByCmd(cmd: string): Promise<any> {
    return { js: { cmd } };
  }

  async getSeriesGroups(): Promise<Data<Genre[]>> {
    return this.genres((await this.lib())?.seriesGroups ?? []);
  }

  private episodeVideo(show: M3uShow, e: M3uShow["seasons"][number][number]): Video {
    return {
      id: e.id, name: e.name, cmd: e.url, screenshot_uri: e.logo || show.logo, category_id: show.groupId, time: 0, rating_imdb: "0",
      series: [], is_episode: 1, series_number: e.season, episode_number: e.episode,
    } as Video;
  }

  private findEpisode(_lib: M3uLibrary, _showId: string, episodeId: string): Video | null {
    const hit = this.idx_()?.episodes.get(episodeId);
    return hit ? this.episodeVideo(hit[0], hit[1]) : null;
  }

  async getSeries(params: MoviesApiParams): Promise<Data<Programs<Video>>> {
    const lib = await this.lib();
    if (!lib) return { js: { total_items: 0, max_page_items: PAGE, data: [] } };
    const show = params.movieId ? this.idx_()?.shows.get(String(params.movieId)) : undefined;
    if (params.movieId && params.seasonId) {
      const eps = (show?.seasons[Number(params.seasonId)] ?? []).map((e) => this.episodeVideo(show!, e));
      return this.page(eps, { ...params, search: undefined, sort: undefined });
    }
    if (params.movieId) {
      const seasons: Video[] = Object.keys(show?.seasons ?? {}).map(Number).sort((a, b) => a - b).map((n) => ({
        id: String(n), name: `Season ${n}`, cmd: "", screenshot_uri: show!.logo, category_id: show!.groupId, time: 0, rating_imdb: "0",
        series: [], is_season: 1,
      } as Video));
      return { js: { total_items: seasons.length, max_page_items: seasons.length, data: seasons } };
    }
    const cat = params.category && params.category !== "*" && params.category !== "0" ? String(params.category) : null;
    const list: Video[] = (cat ? lib.shows.filter((s) => s.groupId === cat) : lib.shows).map((s) => ({
      id: s.id, name: s.name, cmd: "", screenshot_uri: s.logo, category_id: s.groupId, time: 0, rating_imdb: "0", series: [], is_series: 1,
    } as Video));
    return this.page(list, params);
  }

  async getSeriesLink(params: { series: string; id: number | string }): Promise<any> {
    const lib = await this.lib();
    const ep = lib ? this.findEpisode(lib, String(params.series), String(params.id)) : null;
    return { js: { cmd: ep?.cmd ?? "" } };
  }
}
