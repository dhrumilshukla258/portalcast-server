// Each profile's portal ids in their own range (owner, 2026-10-25: with 2-3 profiles, two portals
// both have a category 12 or a movie 5001, and everything stored by those numbers was shared:
// category lists, title details, tags, episodes, TMDB matches, content manager edits).
//
// The first profile (slot 0, config/profileSlots.ts) keeps the portal's own ids, so a server
// with one profile, and the data every server has today, never changes. Another profile's ids
// are moved into slot * 2^48 + id as they come out of the provider and moved back as they go
// in, so every store keyed by id is separate per profile without a change of its own. 2^48
// holds every portal id (Stalker and Xtream number their rows; M3U ids are 48-bit) and 31
// slots keep every id a safe integer, which both apps and SQLite read exactly.
//
// Only plain numbers move: "*", 0 ("none"), and ids that are not numbers (a Stalker season
// "12345:2") pass as they are. Going in, an id outside this profile's range passes as it is.
import { IProvider } from "@/providers/Provider";

export const SLOT_SPAN = 2 ** 48;
export const MAX_SLOT = 31;
const PLAIN = /^[1-9]\d{0,15}$/; // up to 2^53 - 1

/** The portal's id as this profile shows it. Keeps the type (number stays number, text text). */
export function scopedId<T>(id: T, slot: number): T {
  if (!slot) return id;
  if (typeof id === "number") return (Number.isInteger(id) && id > 0 && id < SLOT_SPAN ? slot * SLOT_SPAN + id : id) as T;
  if (typeof id === "string" && PLAIN.test(id)) {
    const n = Number(id);
    return (n < SLOT_SPAN ? String(slot * SLOT_SPAN + n) : id) as T;
  }
  return id;
}

/** The portal's own id for an id this profile showed. */
export function portalId<T>(id: T, slot: number): T {
  if (!slot) return id;
  const n = typeof id === "number" ? id : typeof id === "string" && PLAIN.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || Math.floor(n / SLOT_SPAN) !== slot) return id;
  const raw = n - slot * SLOT_SPAN;
  return (typeof id === "number" ? raw : String(raw)) as T;
}

/** The slot an id belongs to (0: the first profile's, or not a moved id). */
export function slotOfId(id: unknown): number {
  const n = typeof id === "number" ? id : typeof id === "string" && PLAIN.test(id) ? Number(id) : NaN;
  return Number.isSafeInteger(n) ? Math.floor(n / SLOT_SPAN) : 0;
}

const ID_FIELDS = ["id", "category_id", "tv_genre_id"] as const;

function outItem(item: any, slot: number): any {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  let out = item;
  for (const f of ID_FIELDS) {
    if (item[f] === undefined) continue;
    const v = scopedId(item[f], slot);
    if (v !== item[f]) { if (out === item) out = { ...item }; out[f] = v; }
  }
  return out;
}

/** `{ js: [...] }` or `{ js: { data: [...] } }`, with each entry's ids moved. */
function outList<R>(res: R, slot: number): R {
  const js = (res as any)?.js;
  if (Array.isArray(js)) return { ...(res as any), js: js.map((i) => outItem(i, slot)) };
  if (js && Array.isArray(js.data)) return { ...(res as any), js: { ...js, data: js.data.map((i: any) => outItem(i, slot)) } };
  return res;
}

function inParams<P extends Record<string, any>>(params: P, slot: number, keys: string[]): P {
  const out: any = { ...params };
  for (const k of keys) if (out[k] !== undefined) out[k] = portalId(out[k], slot);
  return out;
}

/**
 * The provider as a profile in `slot` sees it. Slot 0 is the provider itself. Anything not
 * about ids (tokens, `cache`, the Stalker helpers downloads use) is the provider's own.
 */
export function scopeProvider(inner: IProvider, slot: number): IProvider {
  if (!slot) return inner;
  const own: Partial<IProvider> = {
    getChannelGroups: async () => outList(await inner.getChannelGroups(), slot),
    getChannels: async () => outList(await inner.getChannels(), slot),
    getEPG: (channelId, date) => inner.getEPG(portalId(channelId, slot), date),
    getMoviesGroups: async () => outList(await inner.getMoviesGroups(), slot),
    getSeriesGroups: async () => outList(await inner.getSeriesGroups(), slot),
    getMovies: async (p) => outList(await inner.getMovies(inParams(p, slot, ["category", "movieId", "seasonId", "episodeId"])), slot),
    getSeries: async (p) => outList(await inner.getSeries(inParams(p, slot, ["category", "movieId", "seasonId", "episodeId"])), slot),
    getMovieLink: (p) => inner.getMovieLink(inParams(p, slot, ["id", "series"])),
    getSeriesLink: (p) => inner.getSeriesLink(inParams(p, slot, ["id", "series"])),
  };
  return new Proxy(inner as any, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(own, prop)) return (own as any)[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as IProvider;
}
