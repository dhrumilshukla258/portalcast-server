// XMLTV guides for M3U profiles: fed chunk by chunk (a guide can be hundreds of MB), keeping only
// programmes from 6 h ago to 2 days ahead, by channel id, plus each channel's display names (to
// match playlist channels that have no tvg-id). Pure: src/providers/m3u/provider.ts downloads.

export interface GuideProgramme { start: number; stop: number; title: string }

export interface Guide {
  /** XMLTV channel id -> programmes in start order (seconds). */
  byChannel: Map<string, GuideProgramme[]>;
  /** Lower-cased display name -> XMLTV channel id. */
  idByName: Map<string, string>;
  builtAt: number;
}

const MAX_PER_CHANNEL = 200;

/** "20261024190000 +0100" -> Unix seconds; NaN when unreadable. */
export function xmltvTime(s: string): number {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2})?(\d{2})?/);
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  const sign = m[7] ? (m[7].startsWith("-") ? -1 : 1) : 0;
  const offset = m[7] ? (Math.abs(+m[7]) * 3600 + +(m[8] || 0) * 60) * sign : 0;
  return utc - offset;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

const attrOf = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`))?.[1] ?? "";

/** A streaming XMLTV reader: push() text chunks, then finish(). */
export class XmltvReader {
  private buf = "";
  private readonly byChannel = new Map<string, GuideProgramme[]>();
  private readonly idByName = new Map<string, string>();
  private readonly from: number;
  private readonly to: number;

  constructor(nowSec = Math.floor(Date.now() / 1000)) {
    this.from = nowSec - 6 * 3600;
    this.to = nowSec + 48 * 3600;
  }

  push(chunk: string): void {
    this.buf += chunk;
    // Whole <programme>…</programme> and <channel>…</channel> elements; keep the unfinished tail.
    let cut = 0;
    const re = /<(programme|channel)\b([^>]*)>([\s\S]*?)<\/\1>|<programme\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      cut = re.lastIndex;
      if (m[1] === "channel") this.channel(m[2], m[3]);
      else if (m[1] === "programme") this.programme(m[2], m[3]);
    }
    if (cut) this.buf = this.buf.slice(cut);
    // An element never longer than 1 MB: drop junk that would grow the buffer forever.
    if (this.buf.length > 1 << 20) this.buf = this.buf.slice(this.buf.lastIndexOf("<"));
  }

  private channel(attrs: string, body: string): void {
    const id = attrOf(attrs, "id");
    if (!id) return;
    const re = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const name = decode(m[1]).toLowerCase();
      if (name && !this.idByName.has(name)) this.idByName.set(name, id);
    }
  }

  private programme(attrs: string, body: string): void {
    const channel = attrOf(attrs, "channel");
    const start = xmltvTime(attrOf(attrs, "start"));
    const stop = xmltvTime(attrOf(attrs, "stop"));
    if (!channel || !Number.isFinite(start)) return;
    const end = Number.isFinite(stop) ? stop : start + 1800;
    if (end < this.from || start > this.to) return;
    const title = decode(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "").slice(0, 300);
    if (!title) return;
    let list = this.byChannel.get(channel);
    if (!list) this.byChannel.set(channel, (list = []));
    if (list.length < MAX_PER_CHANNEL) list.push({ start, stop: end, title });
  }

  finish(now = Date.now()): Guide {
    // In start order, each programme once (real guides list some twice: same start and title).
    for (const [id, list] of this.byChannel) {
      list.sort((a, b) => a.start - b.start);
      this.byChannel.set(id, list.filter((p, i) => i === 0 || p.start !== list[i - 1].start || p.title !== list[i - 1].title));
    }
    return { byChannel: this.byChannel, idByName: this.idByName, builtAt: now };
  }
}
