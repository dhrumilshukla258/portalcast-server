import { ServerRoute } from "@hapi/hapi";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import NodeCache from "node-cache";
import { logger } from "@/utils/logger";
import { streamTokenFromRequest } from "@/services/StreamTokens";

const execFileAsync = promisify(execFile);

// Cache ffprobe metadata for 6 hours
const metadataCache = new NodeCache({ stdTTL: 21600, checkperiod: 600 });

interface MediaTrack {
  index: number;
  codec_name: string;
  codec_type: string;
  language?: string;
  title?: string;
}

interface MediaMetadata {
  duration: number;
  videoCodec: string;
  audio: MediaTrack[];
  subtitles: MediaTrack[];
}

function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http/https URLs are allowed");
  return u;
}

async function probeMetadata(url: string): Promise<MediaMetadata> {
  const cached = metadataCache.get<MediaMetadata>(url);
  if (cached) return cached;

  logger.info(`[Subtitles] Probing: ${url}`);
  const { stdout } = await execFileAsync("ffprobe", [
    "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
    "-probesize", "5000000",
    "-analyzeduration", "2000000",
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    url,
  ], { timeout: 15_000 });
  const data = JSON.parse(stdout);

  const duration = parseFloat(data.format?.duration || "0");
  let videoCodec = "";
  const audio: MediaTrack[] = [];
  const subtitles: MediaTrack[] = [];

  (data.streams || []).forEach((s: any) => {
    if (s.codec_type === "video" && !videoCodec) videoCodec = s.codec_name || "";
    const t: MediaTrack = {
      index: s.index,
      codec_name: s.codec_name || "",
      codec_type: s.codec_type || "",
      language: s.tags?.language || s.tags?.LANGUAGE,
      title: s.tags?.title || s.tags?.TITLE || s.tags?.name || s.tags?.NAME,
    };
    if (t.codec_type === "audio") audio.push(t);
    else if (t.codec_type === "subtitle") subtitles.push(t);
  });

  const meta: MediaMetadata = { duration, videoCodec, audio, subtitles };
  metadataCache.set(url, meta);
  return meta;
}

// These routes probe/extract embedded subtitle tracks from progressive
// (non-HLS) video files for the web player. Unlike every other stream route,
// the resource here can't be pre-tokenized server-side — the client is the
// one that knows which file it's currently playing, and ffprobe/ffmpeg need
// the actual byte stream (not a title) to find what's inside the container.
// So `url=` stays caller-supplied, and the required `?t=` token — the same
// one already minted for the active playback session — serves purely as
// proof the caller is an authenticated identity, same pattern used by the
// old HLS transcode proxy's master.m3u8 route before it was removed.
export const subtitleRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/media/info",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      if (!entry) return h.response({ error: "Unauthorized" }).code(401);

      const { url } = request.query as { url?: string };
      if (!url) return h.response({ error: "Missing url" }).code(400);
      try {
        const raw = Buffer.from(url, "base64").toString("utf-8");
        assertHttpUrl(raw);
        return h.response(await probeMetadata(raw));
      } catch (e: any) {
        logger.error(`[Subtitles] /media/info error: ${e.message}`);
        return h.response({ error: "Probe failed" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/media/subtitle",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      if (!entry) return h.response("Unauthorized").code(401);

      const { url, track } = request.query as { url?: string; track?: string };
      if (!url || track === undefined) return h.response("Missing params").code(400);

      try {
        const raw = Buffer.from(url, "base64").toString("utf-8");
        assertHttpUrl(raw);
        const idx = parseInt(track, 10);
        const args = [
          "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
          "-i", raw,
          "-map", `0:${idx}`,
          "-f", "webvtt",
          "pipe:1",
        ];
        const proc = spawn("ffmpeg", args);
        request.raw.req.on("close", () => { if (!proc.killed) proc.kill("SIGKILL"); });
        proc.stderr.on("data", () => {});
        return h.response(proc.stdout).type("text/vtt").header("Access-Control-Allow-Origin", "*");
      } catch (e: any) {
        logger.error(`[Subtitles] subtitle error: ${e.message}`);
        return h.response("Failed").code(500);
      }
    },
  },
];
