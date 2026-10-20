import { spawn } from "child_process";
import { ServerRoute } from "@hapi/hapi";
import fs from "fs";
import path from "path";
import { MediaFile } from "@/models/MediaFile";
import { streamTokenFromRequest } from "@/services/StreamTokens";
import { recordFromRequest } from "@/services/SecurityEvents";
import { streamTracker } from "@/services/StreamTracker";
import { clientIp } from "@/infra/clientIp";
import { toVtt } from "@/content/subtitleText";
import { logger } from "@/infra/logger";

// Local files, byte for byte (no transcoding), with seeking (HTTP range requests). The ?t=
// stream token names a file id; the path stays on the server. Token-gated like /api/proxy
// (exempt from the bearer check in server.ts), network-checked by streamTokenFromRequest.

const MIME: Record<string, string> = {
  ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t",
  ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".3gp": "video/3gpp",
};
const CHUNK = 1024 * 1024;

/** The local file a token names, or null. */
export async function fileForToken(resource: string | undefined): Promise<{ file: MediaFile; abs: string } | null> {
  const m = /^local:(\d+)$/.exec(resource ?? "");
  if (!m) return null;
  const file = await MediaFile.findByPk(Number(m[1]));
  if (!file || file.missingSince) return null;
  return { file, abs: path.join(file.root, file.relPath) };
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  let start: number, end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

export const localStreamRoutes: ServerRoute[] = [
  {
    method: "GET", // Hapi answers HEAD for GET routes too
    path: "/api/local/stream",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      const target = entry ? await fileForToken(entry.resource) : null;
      if (!entry || !target) {
        if ((request.query as any)?.t && !request.app?.streamTokenWrongNetwork) recordFromRequest(request, "stream_token_invalid");
        return h.response({ error: "Invalid or expired link" }).code(403);
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(target.abs);
      } catch {
        return h.response({ error: "The file is not reachable (is the disk online?)" }).code(404);
      }
      const size = st.size;
      const type = MIME[path.extname(target.abs).toLowerCase()] ?? "application/octet-stream";
      streamTracker.touch("vod", clientIp(request), `local:${target.file.id}`, entry.userLabel, {
        kind: "movie", label: entry.label, category: entry.category,
      });

      const range = parseRange(request.headers.range as string | undefined, size);
      if (range === "invalid") {
        return h.response().code(416).header("Content-Range", `bytes */${size}`);
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = end - start + 1;
      const base = h.response()
        .type(type)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", String(length))
        .header("Cache-Control", "private, no-store")
        .header("Access-Control-Allow-Origin", "*");
      if (range) base.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
      if (request.method === "head") return base;

      const stream = fs.createReadStream(target.abs, { start, end, highWaterMark: CHUNK });
      stream.on("error", (e) => logger.warn(`[local] read error on file ${target.file.id}: ${e.message}`));
      request.raw.req.on("close", () => stream.destroy());
      const res = h.response(stream)
        .type(type)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", String(length))
        .header("Cache-Control", "private, no-store")
        .header("Access-Control-Allow-Origin", "*");
      if (range) res.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
      return res;
    },
  },
  {
    // A subtitle file beside a local video (sidecar), as WebVTT. `s` is its index in the
    // file's sidecar list; the token names the video.
    method: "GET",
    path: "/api/local/subtitle",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      const target = entry ? await fileForToken(entry.resource) : null;
      if (!target) return h.response("Invalid or expired link").code(403);
      const idx = Number((request.query as any)?.s);
      const side = Number.isInteger(idx) ? (target.file.sidecars ?? [])[idx] : undefined;
      if (!side) return h.response("No such subtitle").code(404);
      const subPath = path.join(target.file.root, side.relPath);
      if (side.format === "ass" || side.format === "ssa") {
        // Styled subtitles: FFmpeg turns them into plain WebVTT cues.
        const proc = spawn("ffmpeg", ["-v", "error", "-i", subPath, "-f", "webvtt", "pipe:1"]);
        request.raw.req.on("close", () => { if (!proc.killed) proc.kill("SIGKILL"); });
        proc.stderr.on("data", () => {});
        return h.response(proc.stdout).type("text/vtt").header("Access-Control-Allow-Origin", "*");
      }
      try {
        const raw = fs.readFileSync(subPath, "utf-8");
        const vtt = toVtt(raw);
        if (!vtt) return h.response("Unsupported subtitle file").code(415);
        return h.response(vtt).type("text/vtt").header("Access-Control-Allow-Origin", "*");
      } catch {
        return h.response("Subtitle not readable").code(404);
      }
    },
  },
];
