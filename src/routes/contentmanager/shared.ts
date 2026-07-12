import { ContentOverride } from "@/models/ContentOverride";
import { readChannels } from "@/infra/storage";
import { xtreamCache } from "@/services/xtreamCache";
import { GenreType } from "@/models/Genre";

export function unauthorized(h: any) {
  return h.response({ error: "Unauthorized" }).code(401);
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
