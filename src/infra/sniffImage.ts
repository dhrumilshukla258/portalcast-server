// What a byte buffer actually is, by content, never by extension or a claimed
// Content-Type. Used for every image that enters or passes through the server: avatar
// and carousel uploads, portal logo/poster relays, the image proxy. A file that claims
// to be .png but is HTML, a script or an executable is rejected.

export type ImageKind = "png" | "jpg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg";

const MIME: Record<ImageKind, string> = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml",
};

export function mimeOf(kind: ImageKind): string {
  return MIME[kind];
}

/** Raster formats only (safe to serve from our origin with no further headers). */
export function sniffRasterImage(buf: Uint8Array): Exclude<ImageKind, "svg"> | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif"; // GIF8
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp"; // RIFF....WEBP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp"; // BM
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "ico";
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 && buf[8] === 0x61 && buf[9] === 0x76 && buf[10] === 0x69 && buf[11] === 0x66) return "avif"; // ....ftypavif
  return null;
}

/**
 * Raster formats plus SVG. SVG is text that may carry scripts, so callers that relay
 * it must add a sandboxing Content-Security-Policy (see svgHeaders).
 */
export function sniffImage(buf: Uint8Array): ImageKind | null {
  const raster = sniffRasterImage(buf);
  if (raster) return raster;
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 512))).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Headers that make a relayed SVG inert even if opened directly in a tab. */
export const svgHeaders: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

/** How many bytes the sniffers need. */
export const SNIFF_BYTES = 512;
