/**
 * SRT/WebVTT text -> WebVTT, or null when the text is not a subtitle file. Subtitle
 * providers can answer with an HTML error page or worse; only text with at least one
 * "start --> end" cue is accepted, and anything carrying script-like tags is refused,
 * so nothing but subtitles is ever stored and served as text/vtt.
 */
export function toVtt(text: string): string | null {
  const body = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s+-->\s+(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/m.test(body)) return null;
  if (/<\s*(script|iframe|object|embed)\b/i.test(body)) return null;
  if (/^WEBVTT/.test(body)) return body;
  return "WEBVTT\n\n" + body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
