// Jellyfin as the source of the local library (docs/skill-local-library.md, "Jellyfin").
// Owner 2026-10-28: Jellyfin stays the media server (scanning, metadata, transcoding);
// PortalCast reads its libraries into the same tables the folder scan fills, so the apps
// see "My Library" exactly as before.
//
// Settings › Jellyfin: the server's address and an API key (Jellyfin Dashboard › API Keys).
// Every request carries the key in a header; neither the address nor the key ever reaches
// a client: streams, artwork and subtitles are relayed by this server under stream tokens
// and signed image URLs.
//
// Rows from Jellyfin: LocalItem root "jellyfin", relPath = the Jellyfin item id;
// MediaFile root "jellyfin", relPath = "<item id>/<media source id>", remotePath = the
// file's path as Jellyfin sees it (how a file keeps its ids when Jellyfin re-creates an
// item, and how a folder-library file is taken over: content/library/jellyfinSync.ts).

import crypto from "crypto";
import { setting } from "@/config/settings";
import type { NfoData } from "@/content/library/nfo";
import type { ProbeTrack, SidecarSubtitle } from "@/models/MediaFile";
import type { LocalArt, ArtKind } from "@/content/library/art";

export const JELLYFIN_ROOT = "jellyfin";

export interface JfStream {
  Type: string; Codec?: string; Language?: string; Title?: string; DisplayTitle?: string; Index: number;
  IsDefault?: boolean; IsForced?: boolean; IsExternal?: boolean; Channels?: number; Width?: number; Height?: number;
  VideoRange?: string; VideoRangeType?: string;
}
export interface JfSource { Id: string; Path?: string; Container?: string; Size?: number; RunTimeTicks?: number; Name?: string; MediaStreams?: JfStream[] }
export interface JfPerson { Name: string; Role?: string; Type?: string }
export interface JfItem {
  Id: string; Name: string; Type: string; OriginalTitle?: string; Overview?: string; Taglines?: string[];
  ProductionYear?: number; PremiereDate?: string; CommunityRating?: number; OfficialRating?: string; RunTimeTicks?: number;
  ProviderIds?: Record<string, string>; Genres?: string[]; Studios?: { Name: string }[]; ProductionLocations?: string[];
  People?: JfPerson[]; ImageTags?: Record<string, string>; BackdropImageTags?: string[]; LockData?: boolean;
  MediaSources?: JfSource[]; Path?: string; SeriesId?: string; ParentIndexNumber?: number; IndexNumber?: number; IndexNumberEnd?: number;
  LocationType?: string;
}
export interface JfLibrary { id: string; name: string; kind: "movies" | "series" }

// Tests replace the transport (test/jellyfin-sync.test.ts); nothing else does.
let transport: typeof fetch = (input, init) => fetch(input, init);
export function setJellyfinTransport(f: typeof fetch | null): void {
  transport = f ?? ((input, init) => fetch(input, init));
}

/** The configured server, or null when Jellyfin is not set up. */
export function jellyfinConfig(): { url: string; key: string } | null {
  const url = String(setting<string>("jellyfinUrl") || "").trim().replace(/\/+$/, "");
  const key = String(setting<string>("jellyfinApiKey") || "").trim();
  if (!url || !key || !/^https?:\/\/[^/\s]+/i.test(url)) return null;
  return { url, key };
}

/** Jellyfin item and media source ids: 32 hex characters (dashes allowed). Nothing else goes into a path. */
export function isJellyfinId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** A request to the configured server. `path` starts with "/". Throws when not set up. */
export async function jellyfinFetch(path: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const cfg = jellyfinConfig();
  if (!cfg) throw new Error("Jellyfin is not set up (Settings › Jellyfin)");
  return transport(cfg.url + path, {
    method: init.method ?? "GET",
    signal: init.signal,
    redirect: "error",
    headers: {
      // Jellyfin's scheme; Emby reads X-Emby-Token.
      Authorization: `MediaBrowser Client="PortalCast", Device="PortalCast Server", DeviceId="portalcast-server", Version="1", Token="${cfg.key}"`,
      "X-Emby-Token": cfg.key,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function getJson<T>(path: string, timeoutMs = 60_000): Promise<T> {
  const res = await jellyfinFetch(path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    // The path only (no address, no key) in the message: it reaches the admin page and the log.
    throw new Error(res.status === 401 || res.status === 403 ? "Jellyfin refused the API key" : `Jellyfin answered ${res.status} for ${path.split("?")[0]}`);
  }
  return (await res.json()) as T;
}

/** Name and version of the server: the "Test" in Admin, and a cheap reachability check. */
export async function jellyfinServerInfo(): Promise<{ name: string; version: string }> {
  const info = await getJson<{ ServerName?: string; Version?: string }>("/System/Info", 15_000);
  return { name: info.ServerName || "Jellyfin", version: info.Version || "" };
}

/** Jellyfin's movie and show libraries (other kinds — music, books, mixed — are left out). */
export async function jellyfinLibraries(): Promise<JfLibrary[]> {
  const folders = await getJson<{ Name: string; ItemId: string; CollectionType?: string }[]>("/Library/VirtualFolders", 30_000);
  return folders
    .filter((f) => isJellyfinId(f.ItemId) && (f.CollectionType === "movies" || f.CollectionType === "tvshows"))
    .map((f) => ({ id: f.ItemId, name: f.Name, kind: f.CollectionType === "tvshows" ? "series" : "movies" }));
}

const FIELDS = [
  "ProviderIds", "MediaSources", "Path", "Overview", "Genres", "People", "Studios", "Taglines",
  "ProductionLocations", "OriginalTitle", "OfficialRating", "PremiereDate", "DateCreated",
].join(",");
const PAGE = 200;

/** Every item of the given types under a library, page by page. */
export async function jellyfinItems(parentId: string, types: "Movie" | "Series" | "Episode"): Promise<JfItem[]> {
  if (!isJellyfinId(parentId)) throw new Error("Bad Jellyfin library id");
  const out: JfItem[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await getJson<{ Items?: JfItem[]; TotalRecordCount?: number }>(
      `/Items?ParentId=${parentId}&Recursive=true&IncludeItemTypes=${types}&Fields=${FIELDS}&IsMissing=false&StartIndex=${start}&Limit=${PAGE}&SortBy=SortName`,
    );
    const items = page.Items ?? [];
    out.push(...items.filter((i) => isJellyfinId(i.Id)));
    if (items.length < PAGE || out.length >= (page.TotalRecordCount ?? Infinity)) break;
  }
  return out;
}

// ---- Jellyfin data in our shapes ---------------------------------------------------------

/** A short stable number for an image tag: the version in signed artwork URLs. */
export function tagVersion(tag: string | undefined | null): number {
  if (!tag) return 0;
  return parseInt(crypto.createHash("sha1").update(tag).digest("hex").slice(0, 8), 16);
}

/** The title's artwork as stored on its LocalItem ("art"): which images Jellyfin has, and a version. */
export function artOf(it: JfItem): LocalArt | null {
  const tags = it.ImageTags ?? {};
  const backdrop = it.BackdropImageTags?.[0];
  const art: LocalArt = {};
  if (tags.Primary) art.poster = "Primary";
  if (backdrop) art.backdrop = "Backdrop";
  if (tags.Logo) art.logo = "Logo";
  if (!art.poster && !art.backdrop && !art.logo) return null;
  art.v = tagVersion([tags.Primary, backdrop, tags.Logo].join("|")) % 2_000_000_000;
  return art;
}

const IMAGE_TYPE: Record<ArtKind, string> = { poster: "Primary", backdrop: "Backdrop/0", logo: "Logo", still: "Primary" };

/** Path of one image of an item, optionally scaled to a width (Jellyfin scales it). */
export function jellyfinImagePath(itemId: string, kind: ArtKind, width?: number): string | null {
  if (!isJellyfinId(itemId)) return null;
  const scale = width ? `?maxWidth=${width}&quality=90` : "";
  return `/Items/${itemId}/Images/${IMAGE_TYPE[kind]}${scale}`;
}

/** The file itself, byte for byte (range requests pass through). */
export function jellyfinStreamPath(itemId: string, sourceId: string): string | null {
  if (!isJellyfinId(itemId) || !isJellyfinId(sourceId)) return null;
  return `/Videos/${itemId}/stream?static=true&mediaSourceId=${sourceId}`;
}

/** One subtitle stream as WebVTT (Jellyfin converts embedded and external ones). */
export function jellyfinSubtitlePath(itemId: string, sourceId: string, index: number): string | null {
  if (!isJellyfinId(itemId) || !isJellyfinId(sourceId) || !Number.isInteger(index) || index < 0 || index > 999) return null;
  return `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.vtt`;
}

/**
 * Jellyfin's HLS for a browser that cannot play the file: H.264 + AAC stereo, video copied
 * when it already is H.264 (Jellyfin decides, with its hardware acceleration).
 */
export function jellyfinHlsPath(itemId: string, sourceId: string, session: string): string | null {
  if (!isJellyfinId(itemId) || !isJellyfinId(sourceId) || !/^[\w-]{1,64}$/.test(session)) return null;
  return `/Videos/${itemId}/master.m3u8?MediaSourceId=${sourceId}&DeviceId=portalcast-server&PlaySessionId=${session}` +
    "&VideoCodec=h264&AudioCodec=aac&MaxAudioChannels=2&TranscodingMaxAudioChannels=2&SegmentContainer=ts&BreakOnNonKeyFrames=false";
}

/** "<item id>/<media source id>" (a MediaFile's relPath) split, or null. */
export function jellyfinIdsOf(relPath: string): { itemId: string; sourceId: string } | null {
  const [itemId, sourceId] = String(relPath).split("/");
  return isJellyfinId(itemId) && isJellyfinId(sourceId) ? { itemId, sourceId } : null;
}

function hdrOf(v: JfStream | undefined): string | null {
  const t = String(v?.VideoRangeType || "").toUpperCase();
  if (t.startsWith("DOVI")) return "Dolby Vision";
  if (t === "HDR10" || t === "HDR10PLUS") return "HDR10";
  if (t === "HLG") return "HLG";
  return null;
}

/** What the probe gives for a folder-library file, from Jellyfin's media source instead. */
export function fileFieldsOf(src: JfSource) {
  const streams = src.MediaStreams ?? [];
  const video = streams.find((s) => s.Type === "Video");
  const track = (s: JfStream): ProbeTrack => ({
    index: s.Index,
    codec: String(s.Codec || "").toLowerCase(),
    language: s.Language || null,
    title: s.Title || null,
    channels: s.Channels ?? null,
    default: Boolean(s.IsDefault),
    forced: Boolean(s.IsForced),
  });
  const subs = streams.filter((s) => s.Type === "Subtitle");
  // External subtitles are files beside the video: served from Jellyfin by index.
  const sidecars: SidecarSubtitle[] = subs.filter((s) => s.IsExternal).map((s) => ({
    relPath: `jf:${s.Index}`, language: s.Language || null, forced: Boolean(s.IsForced), format: String(s.Codec || "srt").toLowerCase(),
  }));
  return {
    size: Number(src.Size) || 0,
    container: src.Container ? String(src.Container).split(",")[0].toLowerCase() : null,
    duration: src.RunTimeTicks ? src.RunTimeTicks / 1e7 : null,
    width: video?.Width ?? null,
    height: video?.Height ?? null,
    videoCodec: video?.Codec ? String(video.Codec).toLowerCase() : null,
    hdr: hdrOf(video),
    audioTracks: streams.filter((s) => s.Type === "Audio").map(track),
    subtitleTracks: subs.filter((s) => !s.IsExternal).map(track),
    sidecars,
  };
}

const people = (it: JfItem, type: string) => (it.People ?? []).filter((p) => p.Type === type && p.Name);

/** Jellyfin's metadata in the NFO shape, so the folder library's NFO pass applies it unchanged. */
export function nfoOf(it: JfItem): NfoData {
  const ids = it.ProviderIds ?? {};
  const tmdb = Number(ids.Tmdb ?? ids.tmdb);
  const imdb = String(ids.Imdb ?? ids.imdb ?? "");
  return {
    title: it.Name || null,
    originalTitle: it.OriginalTitle && it.OriginalTitle !== it.Name ? it.OriginalTitle : null,
    plot: it.Overview || null,
    tagline: it.Taglines?.[0] || null,
    year: it.ProductionYear ? String(it.ProductionYear) : null,
    premiered: it.PremiereDate ? it.PremiereDate.slice(0, 10) : null,
    rating: typeof it.CommunityRating === "number" ? Math.round(it.CommunityRating * 10) / 10 : null,
    mpaa: it.OfficialRating || null,
    runtime: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 6e8) : null,
    tmdbId: Number.isInteger(tmdb) && tmdb > 0 ? tmdb : null,
    imdbId: /^tt\d+$/.test(imdb) ? imdb : null,
    tvdbId: ids.Tvdb ? String(ids.Tvdb) : null,
    genres: it.Genres ?? [],
    countries: it.ProductionLocations ?? [],
    studios: (it.Studios ?? []).map((s) => s.Name).filter(Boolean),
    directors: people(it, "Director").map((p) => p.Name),
    writers: people(it, "Writer").map((p) => p.Name),
    actors: people(it, "Actor").map((p, i) => ({ name: p.Name, role: p.Role || null, order: i })),
    collection: null,
    // "Lock this item" in Jellyfin: its edits win over TMDB, as a locked NFO's do.
    locked: Boolean(it.LockData),
  };
}

/** A version's label when a title has several ("2160p", "Director's Cut"): Jellyfin's own name for it. */
export function versionLabelOf(src: JfSource, sources: number): string | null {
  if (sources < 2) return null;
  const name = String(src.Name || "").trim();
  return name ? name.slice(0, 80) : null;
}

/** Path as Jellyfin sees it, with forward slashes (Jellyfin on Windows uses backslashes). */
export function normalizedPath(p: string | undefined | null): string {
  return String(p ?? "").replace(/\\/g, "/");
}

const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BROWSER_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "matroska"]);

/**
 * Whether the webui gets Jellyfin's HLS transcode instead of the file: a video codec, audio
 * codec or container a browser cannot play. Unlike the folder library's fallback, Jellyfin
 * also converts the video (HEVC, MPEG-2...), with its own hardware acceleration.
 */
export function needsJellyfinTranscode(f: { videoCodec: string | null; container: string | null; audioTracks: ProbeTrack[] | null }): boolean {
  if (!setting<boolean>("browserFallback")) return false;
  const tracks = f.audioTracks ?? [];
  const audio = tracks.find((t) => t.default) ?? tracks[0];
  if (f.videoCodec && !BROWSER_VIDEO.has(f.videoCodec)) return true;
  if (audio && !BROWSER_AUDIO.has(String(audio.codec).toLowerCase())) return true;
  return !!f.container && !BROWSER_CONTAINERS.has(f.container);
}
