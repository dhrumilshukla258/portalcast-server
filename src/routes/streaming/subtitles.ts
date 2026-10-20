import { ServerRoute } from "@hapi/hapi";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import NodeCache from "node-cache";
import { logger } from "@/infra/logger";
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

  // Never log the address: an upstream link can carry the portal's credentials.
  logger.info(`[Subtitles] Probing the active stream for embedded tracks`);
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
// (non-HLS) video files for the web player. The file is the one the `?t=`
// stream token was minted for (the token's resource), never an address the
// client sends: a caller-supplied `url=` let any signed-in user make the
// server open arbitrary addresses, including ones inside the home network.
// Older webuis still send `url=`; it is accepted and ignored.
function tokenResource(entry: { resource?: string } | null | undefined): string | null {
  const r = entry?.resource;
  if (!r) return null;
  try {
    assertHttpUrl(r);
    return r;
  } catch {
    return null;
  }
}

export const subtitleRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/media/info",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      if (!entry) return h.response({ error: "Unauthorized" }).code(401);

      const raw = tokenResource(entry);
      if (!raw) return h.response({ error: "This stream has no file to probe" }).code(400);
      try {
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

      const { track } = request.query as { track?: string };
      if (track === undefined) return h.response("Missing params").code(400);
      const raw = tokenResource(entry);
      if (!raw) return h.response("This stream has no file").code(400);
      const idx = parseInt(track, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx > 64) return h.response("Bad track").code(400);

      try {
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
