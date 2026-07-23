import { ContentOverride } from "@/models/ContentOverride";
import { readChannels } from "@/infra/storage";
import { xtreamCache } from "@/services/xtreamCache";
import { GenreType } from "@/models/Genre";

// Re-exported from the central definition in auth/jwt.ts — kept here too
// since every route file in this content-manager panel already imports its
// auth helpers from "./shared" (see also routes/providerConfig.ts, which
// imports requireAdmin directly from @/auth/jwt instead).
export { requireAdmin } from "@/auth/jwt";

export function unauthorized(h: any) {
  return h.response({ error: "Unauthorized" }).code(401);
}

export function forbidden(h: any) {
  return h.response({ error: "Forbidden" }).code(403);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export async function getItemCount(type: GenreType, genreId: string): Promise<number> {
  if (String(genreId).startsWith("vcat_")) {
    return ContentOverride.count({ where: { item_type: type === "channel" ? "channel" : type, target_category_id: genreId } });
  }
  if (type === "channel") {
    const channels = await readChannels();
    return channels.filter((c) => c.tv_genre_id === genreId).length;
  }
  if (type === "movie") {
    const cached = await xtreamCache.get<any[]>(`vod_streams_${genreId}`);
    return cached?.length ?? 0;
  }
  if (type === "series") {
    const cached = await xtreamCache.get<any[]>(`series_list_${genreId}`);
    return cached?.length ?? 0;
  }
  return 0;
}
