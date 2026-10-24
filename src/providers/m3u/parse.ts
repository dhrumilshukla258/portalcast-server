// M3U playlists (owner, 2026-10-24: "we allow stalker, xtream and m3u"): the parser and the
// library built from it. Pure functions; src/providers/m3u/provider.ts downloads and serves.
//
// An entry is `#EXTINF:-1 tvg-id="…" tvg-name="…" tvg-logo="…" group-title="…",Name` and its
// link on the next line (`#EXTGRP:` and `#EXTVLCOPT:` lines may sit between). Each entry is
// sorted into live, movie or episode:
//   - Xtream-style links say it: /live/, /movie/, /series/ (most IPTV playlists);
//   - else a `tvg-type` attribute (live / movie / series), when present;
//   - else the link's file type: a video file (.mp4, .mkv…) is VOD, anything else live;
//   - VOD named like a TV episode ("Show S01E02", "Show 1x02") is an episode, else a movie.
// Ids are numbers made from the entry's kind, group and name (not its link: some providers
// change links at every refresh), so a title keeps its id, its progress and its TMDB match
// across refreshes. 48-bit FNV-1a: no collisions to expect among a few 100k entries.

export type M3uKind = "live" | "movie" | "episode";

export interface M3uEntry {
  name: string;
  url: string;
  group: string;
  logo: string;
  tvgId: string;
  tvgName: string;
  kind: M3uKind;
}

export interface M3uParsed {
  entries: M3uEntry[];
  /** The guide link from the header (`url-tvg` / `x-tvg-url`), if any. */
  guideUrl: string | null;
}

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv|webm|mpe?g|flv|divx|xvid|3gp|ts\?vod)(\?|#|$)/i;
const EPISODE = /^(.*?)[\s._\-:|]*\bS(\d{1,2})\s*[._\- ]?\s*E(\d{1,4})\b|^(.*?)[\s._\-:|]+(\d{1,2})x(\d{1,3})\b/i;

function attr(line: string, name: string): string {
  const m = line.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) || line.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s,]+)`, "i"));
  return m ? m[1].trim() : "";
}

/** The title after the EXTINF attributes: after the first comma outside quotes. */
function titleOf(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) return line.slice(i + 1).trim();
  }
  return "";
}

export function kindOf(url: string, tvgType: string, name: string, group: string): M3uKind {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  let vod: boolean | null = null;
  if (/\/series\//i.test(path)) return "episode";
  if (/\/movies?\//i.test(path)) vod = true;
  else if (/\/live\//i.test(path)) return "live";
  const t = tvgType.toLowerCase();
  if (vod === null && (t === "live" || t === "tv")) return "live";
  if (vod === null && (t === "movie" || t === "movies" || t === "vod")) vod = true;
  if (vod === null && (t === "series" || t === "episode")) return "episode";
  if (vod === null) vod = VIDEO_EXT.test(path);
  if (!vod) return "live";
  return EPISODE.test(name) || (/\bseries\b|\btv shows?\b/i.test(group) && /\bE\d{1,4}\b/i.test(name)) ? "episode" : "movie";
}

/** A playlist read line by line: push() each line, then finish(). Holds only the entries. */
export class M3uParser {
  private readonly entries: M3uEntry[] = [];
  private guideUrl: string | null = null;
  private pending: { line: string; group: string } | null = null;
  private first = true;

  push(raw: string): void {
    if (this.first) { raw = raw.replace(/^﻿/, ""); this.first = false; }
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("#EXTM3U")) {
      const g = attr(line, "url-tvg") || attr(line, "x-tvg-url");
      if (g) this.guideUrl = g.split(",")[0].trim() || this.guideUrl;
      return;
    }
    if (line.startsWith("#EXTINF")) { this.pending = { line, group: "" }; return; }
    if (line.startsWith("#EXTGRP:")) { if (this.pending) this.pending.group = line.slice(8).trim(); return; }
    if (line.startsWith("#")) return; // #EXTVLCOPT, #KODIPROP and the like
    const pending = this.pending;
    if (!pending) return; // a link without its EXTINF line
    this.pending = null;
    if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(line)) return;
    const name = (titleOf(pending.line) || attr(pending.line, "tvg-name")).slice(0, 300);
    const group = (attr(pending.line, "group-title") || pending.group || "Uncategorized").slice(0, 200);
    if (!name) return;
    this.entries.push({
      name, url: line, group,
      logo: attr(pending.line, "tvg-logo"),
      tvgId: attr(pending.line, "tvg-id"),
      tvgName: attr(pending.line, "tvg-name"),
      kind: kindOf(line, attr(pending.line, "tvg-type"), name, group),
    });
  }

  finish(): M3uParsed {
    return { entries: this.entries, guideUrl: this.guideUrl };
  }
}

/** Parses playlist lines (any iterable). */
export function parseM3u(lines: Iterable<string>): M3uParsed {
  const p = new M3uParser();
  for (const l of lines) p.push(l);
  return p.finish();
}

// ---- library ---------------------------------------------------------------------------

/** A positive 48-bit FNV-1a hash: a stable numeric id. */
export function idOf(key: string): number {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const n = Number(h & 0xffffffffffffn);
  return n === 0 ? 1 : n;
}

export interface M3uGroup { id: string; title: string }
export interface M3uChannel { id: string; name: string; url: string; logo: string; groupId: string; tvgId: string; tvgName: string; number: number }
export interface M3uMovie { id: string; name: string; url: string; logo: string; groupId: string; ext: string }
export interface M3uEpisode { id: string; season: number; episode: number; name: string; url: string; logo: string; ext: string }
export interface M3uShow { id: string; name: string; logo: string; groupId: string; seasons: Record<number, M3uEpisode[]> }

export interface M3uLibrary {
  builtAt: number;
  guideUrl: string | null;
  liveGroups: M3uGroup[];
  channels: M3uChannel[];
  movieGroups: M3uGroup[];
  movies: M3uMovie[];
  seriesGroups: M3uGroup[];
  shows: M3uShow[];
}

function extOf(url: string): string {
  const m = url.replace(/[?#].*$/, "").match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "mp4";
}

/** "Show S01E02 - Title" -> ["Show", 1, 2]; null when the name has no episode number. */
export function episodeOf(name: string): [string, number, number] | null {
  const m = name.match(EPISODE);
  if (!m) return null;
  const show = (m[1] ?? m[4] ?? "").replace(/[\s._\-:|([]+$/, "").trim();
  const season = Number(m[2] ?? m[5]);
  const episode = Number(m[3] ?? m[6]);
  return show ? [show, season, episode] : null;
}

export function buildLibrary(parsed: M3uParsed, now = Date.now()): M3uLibrary {
  const groups = { live: new Map<string, M3uGroup>(), movie: new Map<string, M3uGroup>(), series: new Map<string, M3uGroup>() };
  const groupOf = (kind: "live" | "movie" | "series", title: string): M3uGroup => {
    let g = groups[kind].get(title);
    if (!g) groups[kind].set(title, (g = { id: String(idOf(`group|${kind}|${title}`)), title }));
    return g;
  };
  // The same name twice in one group (another quality, a backup link) gets its own id.
  const seen = new Map<string, number>();
  const unique = (key: string) => { const n = seen.get(key) ?? 0; seen.set(key, n + 1); return n ? `${key}|${n}` : key; };

  const channels: M3uChannel[] = [];
  const movies: M3uMovie[] = [];
  const shows = new Map<string, M3uShow>();
  for (const e of parsed.entries) {
    if (e.kind === "live") {
      const g = groupOf("live", e.group);
      channels.push({ id: String(idOf(unique(`live|${e.group}|${e.name}`))), name: e.name, url: e.url, logo: e.logo, groupId: g.id, tvgId: e.tvgId, tvgName: e.tvgName, number: channels.length + 1 });
    } else if (e.kind === "movie") {
      const g = groupOf("movie", e.group);
      movies.push({ id: String(idOf(unique(`movie|${e.group}|${e.name}`))), name: e.name, url: e.url, logo: e.logo, groupId: g.id, ext: extOf(e.url) });
    } else {
      const ep = episodeOf(e.name) ?? [e.name.replace(/\s*\bE\d{1,4}\b.*$/i, "").trim() || e.name, 1, Number(e.name.match(/\bE(\d{1,4})\b/i)?.[1] ?? 1)];
      const [showName, season, episode] = ep;
      const g = groupOf("series", e.group);
      const showKey = `${e.group}|${showName.toLowerCase()}`;
      let show = shows.get(showKey);
      if (!show) shows.set(showKey, (show = { id: String(idOf(`show|${showKey}`)), name: showName, logo: e.logo, groupId: g.id, seasons: {} }));
      if (!show.logo && e.logo) show.logo = e.logo;
      const list = (show.seasons[season] ||= []);
      list.push({ id: String(idOf(unique(`ep|${show.id}|${season}|${episode}`))), season, episode, name: e.name, url: e.url, logo: e.logo, ext: extOf(e.url) });
    }
  }
  for (const s of shows.values()) for (const k of Object.keys(s.seasons)) s.seasons[+k].sort((a, b) => a.episode - b.episode);
  return {
    builtAt: now,
    guideUrl: parsed.guideUrl,
    liveGroups: [...groups.live.values()],
    channels,
    movieGroups: [...groups.movie.values()],
    movies,
    seriesGroups: [...groups.series.values()],
    shows: [...shows.values()],
  };
}
