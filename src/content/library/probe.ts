// What is inside a local video file, from ffprobe (in the Docker image). Run once per file
// and again only when its size or modified time changes (scanner.ts).

import { execFile } from "child_process";
import { promisify } from "util";
import type { ProbeTrack } from "@/models/MediaFile";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  container: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hdr: string | null;
  audioTracks: ProbeTrack[];
  subtitleTracks: ProbeTrack[];
}

function hdrOf(v: any): string | null {
  const side = JSON.stringify(v?.side_data_list ?? []);
  if (/dovi|dolby vision/i.test(side) || /dvh1|dvhe/i.test(String(v?.codec_tag_string ?? ""))) return "Dolby Vision";
  if (v?.color_transfer === "smpte2084") return "HDR10";
  if (v?.color_transfer === "arib-std-b67") return "HLG";
  return null;
}

export async function probeFile(absPath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", absPath],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const streams: any[] = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const track = (s: any): ProbeTrack => ({
    index: s.index,
    codec: s.codec_name || "",
    language: s.tags?.language || s.tags?.LANGUAGE || null,
    title: s.tags?.title || s.tags?.TITLE || null,
    channels: s.channels ?? null,
    default: Boolean(s.disposition?.default),
    forced: Boolean(s.disposition?.forced),
  });
  const duration = Number(data.format?.duration);
  return {
    container: String(data.format?.format_name || "").split(",")[0] || null,
    duration: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    hdr: video ? hdrOf(video) : null,
    audioTracks: streams.filter((s) => s.codec_type === "audio").map(track),
    subtitleTracks: streams.filter((s) => s.codec_type === "subtitle").map(track),
  };
}

/** "2160p", "1080p", "720p" or "SD" from a frame size. */
export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  if (width >= 3200 || height >= 1800) return "2160p";
  if (width >= 1700 || height >= 1000) return "1080p";
  if (width >= 1200 || height >= 700) return "720p";
  return "SD";
}
