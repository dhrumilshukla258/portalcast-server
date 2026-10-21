// Full reader for Kodi/Jellyfin NFO files (movie.nfo, tvshow.nfo, <episode>.nfo). Jellyfin
// writes most of what it knows into them: plot, ratings, ids, genres, cast, crew, and
// "lockdata" when you edited a title by hand. The local library uses them as a metadata
// source of its own (content/library/scanner.ts): they fill whatever TMDB does not give,
// and a locked NFO wins over TMDB, as Jellyfin's own edits should.
//
// A small tag reader, not an XML library: NFO files are flat, and only text is read
// (never URLs from them, never anything executed).

export interface NfoActor { name: string; role: string | null; order: number }

export interface NfoData {
  title: string | null;
  originalTitle: string | null;
  plot: string | null;
  tagline: string | null;
  year: string | null;
  premiered: string | null;
  rating: number | null;
  mpaa: string | null;
  runtime: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: string | null;
  genres: string[];
  countries: string[];
  studios: string[];
  directors: string[];
  writers: string[];
  actors: NfoActor[];
  collection: string | null;
  locked: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

function all(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const v = decode(m[1]);
    if (v) out.push(v);
  }
  return out;
}

function one(xml: string, ...tags: string[]): string | null {
  for (const t of tags) {
    const v = all(xml, t)[0];
    if (v) return v;
  }
  return null;
}

function uniqueId(xml: string, type: string): string | null {
  const m = xml.match(new RegExp(`<uniqueid[^>]*type=["']${type}["'][^>]*>\\s*([^<]+?)\\s*</uniqueid>`, "i"));
  return m ? decode(m[1]) : null;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function parseNfoFull(raw: string): NfoData {
  // The root's direct text only: drop nested <actor>/<fileinfo>/<set> blocks before reading
  // simple tags, so an actor's <name> or a stream's <language> is never taken for the title.
  const xml = String(raw).replace(/^﻿/, "");
  const actorsXml = all(xml, "actor");
  const setXml = all(xml, "set")[0] ?? null;
  const flat = xml
    .replace(/<actor(?:\s[^>]*)?>[\s\S]*?<\/actor>/gi, "")
    .replace(/<fileinfo(?:\s[^>]*)?>[\s\S]*?<\/fileinfo>/gi, "")
    .replace(/<set(?:\s[^>]*)?>[\s\S]*?<\/set>/gi, "")
    .replace(/<art(?:\s[^>]*)?>[\s\S]*?<\/art>/gi, "")
    .replace(/<ratings(?:\s[^>]*)?>[\s\S]*?<\/ratings>/gi, "");

  const tmdbRaw = uniqueId(xml, "tmdb") ?? one(flat, "tmdbid");
  const imdbRaw = uniqueId(xml, "imdb") ?? one(flat, "imdbid", "imdb_id") ?? (one(flat, "id")?.match(/^tt\d+$/) ? one(flat, "id") : null);
  const tvdbRaw = uniqueId(xml, "tvdb") ?? one(flat, "tvdbid");
  const premiered = one(flat, "premiered", "aired", "releasedate");
  const yearRaw = one(flat, "year") ?? premiered?.slice(0, 4) ?? null;
  const rating = Number(one(flat, "rating"));
  const runtime = Number(one(flat, "runtime"));

  const actors: NfoActor[] = actorsXml
    .map((a, i) => {
      const name = one(a, "name");
      const type = one(a, "type");
      if (!name || (type && !/actor|guest/i.test(type))) return null;
      const order = Number(one(a, "sortorder", "order"));
      return { name, role: one(a, "role"), order: Number.isFinite(order) ? order : i };
    })
    .filter((a): a is NfoActor => a !== null)
    .sort((a, b) => a.order - b.order);

  return {
    title: one(flat, "title"),
    originalTitle: one(flat, "originaltitle"),
    plot: one(flat, "plot", "outline"),
    tagline: one(flat, "tagline"),
    year: yearRaw && /^\d{4}$/.test(yearRaw) ? yearRaw : null,
    premiered: premiered && /^\d{4}-\d{2}-\d{2}/.test(premiered) ? premiered.slice(0, 10) : null,
    rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null,
    mpaa: one(flat, "mpaa")?.replace(/^Rated\s+/i, "") ?? null,
    runtime: Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime) : null,
    tmdbId: tmdbRaw && /^\d+$/.test(tmdbRaw) ? Number(tmdbRaw) : null,
    imdbId: imdbRaw && /^tt\d+$/.test(imdbRaw) ? imdbRaw : null,
    tvdbId: tvdbRaw && /^\d+$/.test(tvdbRaw) ? tvdbRaw : null,
    genres: uniq(all(flat, "genre").flatMap((g) => g.split(/\s*\/\s*/))),
    countries: uniq(all(flat, "country")),
    studios: uniq(all(flat, "studio")),
    directors: uniq(all(flat, "director")),
    writers: uniq(all(flat, "writer").concat(all(flat, "credits"))),
    actors,
    collection: setXml ? (one(setXml, "name") ?? (setXml.includes("<") ? null : setXml)) : null,
    locked: /<lockdata>\s*true\s*<\/lockdata>/i.test(xml),
  };
}
