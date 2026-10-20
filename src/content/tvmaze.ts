// TVmaze (https://www.tvmaze.com/api): descriptions, cast and creators for series TMDB does
// not know. Public API, no key; limit 20 calls per 10 s per address.
//
// Only an EXACT title match is accepted (TVmaze's search returns fuzzy guesses: "Nawal" ->
// "Rafa Nadal Academy"), and then only when it is the single exact match, or its channel is
// ours, or its premiere year is within one of ours. On a sample of 80 unmatched series 13%
// matched exactly and 12% had a description (2026-10-20); most regional daily soaps are not
// on TVmaze. Results only fill empty fields.

import axios from "axios";
import { logger } from "@/infra/logger";

const BASE = "https://api.tvmaze.com";
const MIN_GAP_MS = 550; // 20 calls / 10 s with a margin
let last = 0;

async function get(path: string): Promise<any | null> {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const { data } = await axios.get(BASE + path, { timeout: 10000 });
    return data;
  } catch (e: any) {
    if (e?.response?.status === 429) {
      await new Promise((r) => setTimeout(r, 10000));
      return null;
    }
    if (e?.response?.status !== 404) logger.debug(`[tvmaze] ${path}: ${e?.message ?? e}`);
    return null;
  }
}

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const channelNorm = (s: string) => norm(s).replace(/\b(tv|channel|india|hd)\b/g, " ").replace(/\s+/g, "").trim();

export interface TvmazeShow {
  id: number;
  name: string;
  summary: string | null;
  cast: string | null;
  creators: string | null;
  poster: string | null;
  premiered: string | null;
  network: string | null;
  rating: number | null;
}

/** Plain text from TVmaze's HTML summary ("<p>Text <b>bold</b></p>" -> "Text bold"). */
function plain(html: string | null | undefined): string | null {
  if (!html) return null;
  const t = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  return t || null;
}

/**
 * The show for a cleaned title, or null. `year` is ours (may be the portal's, often the
 * latest season's); `channel` is the channel taken out of the name ("Colors"), if any.
 */
export async function findTvmazeShow(title: string, year?: string | null, channel?: string | null): Promise<TvmazeShow | null> {
  const q = title.replace(/\s*(?:S\d{1,2}|Season\s*\d+.*)$/i, "").trim();
  if (q.length < 2) return null;
  const results: any[] = (await get(`/search/shows?q=${encodeURIComponent(q)}`)) || [];
  const exact = results.map((r) => r.show).filter((s) => s && norm(s.name) === norm(q));
  if (exact.length === 0) return null;
  const y = Number(year) || null;
  const fits = (s: any) => {
    const net = (s.network || s.webChannel || {}).name || "";
    if (channel && net && channelNorm(net) === channelNorm(channel)) return true;
    const py = Number(String(s.premiered || "").slice(0, 4)) || null;
    return y !== null && py !== null && Math.abs(py - y) <= 1;
  };
  // A single exact match is accepted unless it premiered after our year (it cannot be the
  // show we have then); with several, one must fit by channel or year.
  const premieredAfterOurs = (s: any) => {
    const py = Number(String(s.premiered || "").slice(0, 4)) || null;
    return y !== null && py !== null && py > y + 1;
  };
  const pick = exact.length === 1 ? (premieredAfterOurs(exact[0]) ? null : exact[0]) : exact.find(fits);
  if (!pick) return null;
  const full = await get(`/shows/${pick.id}?embed[]=cast&embed[]=crew`);
  const cast = (full?._embedded?.cast || []).slice(0, 8).map((c: any) => c?.person?.name).filter(Boolean).join(", ") || null;
  const creators = (full?._embedded?.crew || []).filter((c: any) => c?.type === "Creator").map((c: any) => c?.person?.name).filter(Boolean).join(", ") || null;
  return {
    id: pick.id,
    name: pick.name,
    summary: plain(pick.summary),
    cast,
    creators,
    poster: pick.image?.original || pick.image?.medium || null,
    premiered: pick.premiered || null,
    network: (pick.network || pick.webChannel || {}).name || null,
    rating: typeof pick.rating?.average === "number" && pick.rating.average > 0 ? pick.rating.average : null,
  };
}
