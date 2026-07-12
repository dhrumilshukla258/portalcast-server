import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/infra/logger";
import { authCheck } from "@/auth/jwt";
import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { readGenres, readChannels } from "@/infra/storage";
import { xtreamCache, bumpVodVersion } from "@/services/xtreamCache";
import { genreKey, contentKey } from "@/content/overrides";
import { invalidateVodCache } from "@/providers/getM3uUrls";
import { GenreType } from "@/models/Genre";
import { generateStrmFiles } from "@/content/strmGenerator";
import { unauthorized, getItemCount } from "./shared";
export const itemRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/items",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, category_id } = request.query as { type?: string; category_id?: string };
      if (!type || !["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }

      // Virtual categories have no portal cache — fetch from ContentOverride directly
      if (category_id?.startsWith("vcat_")) {
        const movedIn = await ContentOverride.findAll({
          where: { item_type: type, target_category_id: category_id },
          raw: true,
        });
        const result = await Promise.all(movedIn.map(async (ov) => {
          const id = ov.item_key.replace(`${type}_`, "");
          const cacheKey = type === "movie" ? `vod_streams_${ov.original_category_id}` : `series_list_${ov.original_category_id}`;
          const srcItems = await xtreamCache.get<any[]>(cacheKey) ?? [];
          const srcItem = type === "movie"
            ? srcItems.find((i: any) => String(i.stream_id) === id)
            : srcItems.find((i: any) => String(i.series_id) === id);
          return {
            id,
            name: ov.display_name ?? srcItem?.name ?? id,
            original_category_id: ov.original_category_id,
            display_name: ov.display_name ?? null,
            hidden: ov.hidden ?? false,
            target_category_id: category_id,
            sort_order: ov.sort_order ?? null,
          };
        }));
        result.sort((a: any, b: any) => {
          if (a.sort_order == null && b.sort_order == null) return 0;
          if (a.sort_order == null) return 1;
          if (b.sort_order == null) return -1;
          return a.sort_order - b.sort_order;
        });
        return h.response(result);
      }

      let rawItems: any[] = [];

      if (type === "channel") {
        const channels = await readChannels();
        rawItems = category_id
          ? channels.filter((c) => c.tv_genre_id === category_id)
          : channels;
        rawItems = rawItems.map((c) => ({ id: String(c.id), name: c.name, original_category_id: c.tv_genre_id }));
      } else if (type === "movie") {
        if (!category_id) return h.response({ error: "category_id required" }).code(400);
        const cached = await xtreamCache.get<any[]>(`vod_streams_${category_id}`);
        rawItems = (cached ?? []).map((m) => ({
          id: String(m.stream_id),
          name: m.name,
          original_category_id: m.category_id,
        }));
      } else if (type === "series") {
        if (!category_id) return h.response({ error: "category_id required" }).code(400);
        const cached = await xtreamCache.get<any[]>(`series_list_${category_id}`);
        rawItems = (cached ?? []).map((s) => ({
          id: String(s.series_id),
          name: s.name,
          original_category_id: s.category_id,
        }));
      }

      const keys = rawItems.map((i) => contentKey(type, i.id));
      const overrides = await ContentOverride.findAll({ where: { item_key: keys }, raw: true });
      const ovMap = new Map(overrides.map((o) => [o.item_key, o]));

      const result = rawItems.map((item) => {
        const ov = ovMap.get(contentKey(type, item.id));
        return {
          id: item.id,
          name: item.name,
          original_category_id: item.original_category_id,
          display_name: ov?.display_name ?? null,
          hidden: ov?.hidden ?? false,
          target_category_id: ov?.target_category_id ?? null,
          sort_order: (ov as any)?.sort_order ?? null,
        };
      });

      // For VOD/Series: also show items moved INTO this category from elsewhere
      if (category_id && (type === "movie" || type === "series")) {
        const existingIds = new Set(rawItems.map((i) => i.id));
        const movedIn = await ContentOverride.findAll({
          where: { item_type: type, target_category_id: category_id },
          raw: true,
        });
        for (const ov of movedIn) {
          const id = ov.item_key.replace(`${type}_`, "");
          if (existingIds.has(id)) continue;
          const cacheKey = type === "movie" ? `vod_streams_${ov.original_category_id}` : `series_list_${ov.original_category_id}`;
          const srcItems = await xtreamCache.get<any[]>(cacheKey) ?? [];
          const srcItem = type === "movie"
            ? srcItems.find((i: any) => String(i.stream_id) === id)
            : srcItems.find((i: any) => String(i.series_id) === id);
          result.push({
            id,
            name: ov.display_name ?? srcItem?.name ?? id,
            original_category_id: ov.original_category_id,
            display_name: ov.display_name ?? null,
            hidden: ov.hidden ?? false,
            target_category_id: ov.target_category_id,
            sort_order: (ov as any).sort_order ?? null,
          });
        }
      }

      result.sort((a: any, b: any) => {
        if (a.sort_order == null && b.sort_order == null) return 0;
        if (a.sort_order == null) return 1;
        if (b.sort_order == null) return -1;
        return a.sort_order - b.sort_order;
      });
      return h.response(result);
    },
  },
  {
    method: "PUT",
    path: "/api/admin/items/{type}/{category_id}/reorder",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, category_id } = request.params as { type: string; category_id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { order } = request.payload as { order: Array<{ id: string; sort_order: number }> };
      for (const { id, sort_order } of order) {
        const key = contentKey(type, id);
        const existing = await ContentOverride.findByPk(key);
        if (existing) {
          await existing.update({ sort_order });
        } else {
          try {
            await ContentOverride.create({
              item_key: key,
              item_type: type,
              display_name: null,
              hidden: false,
              sort_order,
              target_category_id: null,
              original_category_id: category_id,
            });
          } catch {
            // Row created between our find and create — just update sort_order
            await ContentOverride.update({ sort_order }, { where: { item_key: key } });
          }
        }
      }
      if (type !== "channel") await bumpVodVersion();
      return h.response({ success: true });
    },
  },
  {
    method: "PUT",
    path: "/api/admin/items/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { display_name, hidden, target_category_id, original_category_id } = request.payload as any;
      const key = contentKey(type, id);
      await ContentOverride.upsert({
        item_key: key,
        item_type: type,
        display_name: display_name ?? null,
        hidden: hidden ?? false,
        target_category_id: target_category_id ?? null,
        original_category_id: original_category_id ?? null,
      });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/items/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      await ContentOverride.destroy({ where: { item_key: contentKey(type, id) } });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

];
