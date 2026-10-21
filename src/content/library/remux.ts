// Browser fallback for local files a browser cannot play as they are (docs/skill-local-library.md):
// MKV/AVI with AC3, DTS or TrueHD audio. The video is NOT re-encoded: the file is served as
// HLS whose segments are cut exactly on the file's own keyframes, the video copied, and only
// the audio converted to AAC stereo (a small fraction of one CPU core). Seeking works because
// every segment starts on a keyframe. The TV app never uses this: it plays the file directly.
//
// The keyframe list is read once per file (ffprobe reads the packet headers, ~20-60 s for a
// large file) and kept on the MediaFile row.

import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import { MediaFile } from "@/models/MediaFile";
import { setting } from "@/config/settings";
import { logger } from "@/infra/logger";

const execFileAsync = promisify(execFile);

/** Audio a browser plays itself; anything else is converted to AAC by the fallback. */
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** Containers a browser cannot open even when the codecs inside are fine. */
const NON_BROWSER_CONTAINERS = new Set(["avi", "mpegts", "mpeg", "flv", "asf", "wmv"]);
const TARGET_SEGMENT = 6;

function defaultAudio(f: MediaFile) {
  const tracks = f.audioTracks ?? [];
  return tracks.find((t) => t.default) ?? tracks[0] ?? null;
}

/** Whether the webui should get the HLS fallback for this file instead of the file itself. */
export function needsBrowserFallback(f: MediaFile): boolean {
  if (!setting<boolean>("browserFallback")) return false;
  if (!f.probedAt || f.probeError) return false;
  // Video is copied, never converted: only H.264 is safe in every browser.
  if (f.videoCodec !== "h264") return false;
  const audio = defaultAudio(f);
  const audioOk = !audio || BROWSER_AUDIO.has(String(audio.codec).toLowerCase());
  const containerOk = !NON_BROWSER_CONTAINERS.has(String(f.container || "").toLowerCase()) && path.extname(f.relPath).toLowerCase() !== ".avi";
  return !(audioOk && containerOk);
}

const inflight = new Map<number, Promise<number[] | null>>();

/** The file's keyframe times in seconds (read once, then stored). */
export function keyframesFor(f: MediaFile, abs: string): Promise<number[] | null> {
  const stored = (f as any).keyframes as number[] | null;
  if (Array.isArray(stored) && stored.length) return Promise.resolve(stored);
  const running = inflight.get(f.id);
  if (running) return running;
  const job = (async () => {
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", abs],
        { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 },
      );
      const times: number[] = [];
      for (const line of stdout.split("\n")) {
        const [pts, flags] = line.split(",");
        if (flags && flags.includes("K")) {
          const t = Number(pts);
          if (Number.isFinite(t)) times.push(Math.round(t * 1000) / 1000);
        }
      }
      times.sort((a, b) => a - b);
      if (!times.length) return null;
      await MediaFile.update({ keyframes: times } as any, { where: { id: f.id } });
      return times;
    } catch (e: any) {
      logger.warn(`[remux] keyframes of file ${f.id} could not be read: ${e?.message ?? e}`);
      return null;
    } finally {
      inflight.delete(f.id);
    }
  })();
  inflight.set(f.id, job);
  return job;
}

export interface Segment { start: number; duration: number }

/** Segments of about 6 s, each starting on a keyframe. */
export function segmentsFor(keyframes: number[], total: number): Segment[] {
  const starts: number[] = [];
  let last = -Infinity;
  for (const k of keyframes) {
    if (k - last >= TARGET_SEGMENT || starts.length === 0) {
      starts.push(starts.length === 0 ? 0 : k);
      last = starts.length === 1 ? 0 : k;
    }
  }
  return starts.map((s, i) => ({ start: s, duration: Math.max(0.1, (starts[i + 1] ?? total) - s) }));
}

export function playlistFor(segments: Segment[], token: string): string {
  const target = Math.ceil(Math.max(...segments.map((s) => s.duration)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  segments.forEach((s, i) => {
    lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `seg.ts?t=${token}&i=${i}`);
  });
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** One segment as MPEG-TS: video copied, audio to AAC stereo, timestamps continuous. */
export function segmentProcess(f: MediaFile, abs: string, seg: Segment): ChildProcess {
  const audio = defaultAudio(f);
  const args = [
    "-v", "error",
    "-ss", seg.start.toFixed(3),
    "-i", abs,
    "-t", seg.duration.toFixed(3),
    "-map", "0:v:0",
    ...(audio ? ["-map", `0:${audio.index}`] : []),
    "-c:v", "copy",
    ...(audio ? ["-c:a", "aac", "-ac", "2", "-b:a", "192k"] : []),
    "-sn", "-dn",
    "-output_ts_offset", seg.start.toFixed(3),
    "-muxdelay", "0",
    "-f", "mpegts",
    "pipe:1",
  ];
  return spawn("ffmpeg", args);
}
