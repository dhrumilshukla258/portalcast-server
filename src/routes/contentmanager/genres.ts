import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/infra/logger";
import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { readGenres, readChannels } from "@/infra/storage";
import { xtreamCache, bumpVodVersion } from "@/services/xtreamCache";
import { genreKey, contentKey } from "@/content/overrides";
import { invalidateVodCache } from "@/providers/getM3uUrls";
import { GenreType } from "@/models/Genre";
import { generateStrmFiles } from "@/content/strmGenerator";
import { requireAdmin, forbidden, getItemCount } from "./shared";
export const genreRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/genres",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type } = request.query as { type?: string };
      if (!type || !["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const genreType = type as GenreType;
      const genres = await readGenres(genreType);
      const keys = genres.map((g) => genreKey(genreType, String(g.id)));
      const overrides = await GenreOverride.findAll({ where: { genre_key: keys }, raw: true });
      const ovMap = new Map(overrides.map((o) => [o.genre_key, o]));

      const result = await Promise.all(
        genres.map(async (g) => {
          const ov = ovMap.get(genreKey(genreType, String(g.id)));
          const count = await getItemCount(genreType, String(g.id));
          return {
            id: String(g.id),
            title: g.title,
            display_name: ov?.display_name ?? null,
            hidden: ov?.hidden ?? false,
            sort_order: (ov as any)?.sort_order ?? null,
            count,
          };
        }),
      );

      // Also include virtual categories for this type
      const prefix = `${genreType}_`;
      const virtualRows = await GenreOverride.findAll({ where: { virtual: true }, raw: true });
      const virtualResult = await Promise.all(
        virtualRows
          .filter((r) => r.genre_key.startsWith(prefix))
          .map(async (r) => {
            const id = r.genre_key.slice(prefix.length);
            const count = await getItemCount(genreType, id);
            return {
              id,
              title: r.virtual_title ?? id,
              display_name: null,
              hidden: false,
              sort_order: r.sort_order ?? null,
              count,
              virtual: true,
            };
          }),
      );

      const combined = [...result, ...virtualResult];
      combined.sort((a, b) => {
        if (a.sort_order == null && b.sort_order == null) return 0;
        if (a.sort_order == null) return 1;
        if (b.sort_order == null) return -1;
        return a.sort_order - b.sort_order;
      });
      return h.response(combined);
    },
  },
  {
    method: "POST",
    path: "/api/admin/genres/{type}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type } = request.params as { type: string };
      if (!["movie", "series"].includes(type)) {
        return h.response({ error: "Virtual categories only supported for movie and series" }).code(400);
      }
      const { title } = request.payload as any;
      if (!title?.trim()) return h.response({ error: "Title required" }).code(400);
      const id = `vcat_${Date.now()}`;
      const key = genreKey(type as GenreType, id);
      await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order: null, virtual: true, virtual_title: title.trim() });
      invalidateVodCache();
      return h.response({ id, key });
    },
  },
  {
    method: "PUT",
    path: "/api/admin/genres/{type}/reorder",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type } = request.params as { type: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { order } = request.payload as { order: Array<{ id: string; sort_order: number }> };
      for (const { id, sort_order } of order) {
        const key = genreKey(type as GenreType, id);
        const existing = await GenreOverride.findByPk(key);
        if (existing) {
          await existing.update({ sort_order });
        } else {
          await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order });
        }
      }
      invalidateVodCache();
      if (type !== "channel") await bumpVodVersion();
      return h.response({ success: true });
    },
  },
  {
    method: "PUT",
    path: "/api/admin/genres/{type}/{id}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { display_name, hidden, virtual_title } = request.payload as any;
      const key = genreKey(type as GenreType, id);
      const existing = await GenreOverride.findByPk(key);
      if (existing?.virtual) {
        await existing.update({ virtual_title: virtual_title ?? existing.virtual_title });
      } else if (existing) {
        await existing.update({ display_name: display_name ?? null, hidden: hidden ?? false });
      } else {
        await GenreOverride.create({ genre_key: key, display_name: display_name ?? null, hidden: hidden ?? false, sort_order: null, virtual: false, virtual_title: null });
      }
      invalidateVodCache();
      return h.response({ success: true });
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/genres/{type}/order",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type } = request.params as { type: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const prefix = `${type}_`;
      const rows = await GenreOverride.findAll({ raw: true });
      for (const row of rows.filter((r) => r.genre_key.startsWith(prefix))) {
        const instance = await GenreOverride.findByPk(row.genre_key);
        if (!instance) continue;
        if (instance.virtual) {
          // Keep the row (it defines the category) but clear its position
          await instance.update({ sort_order: null });
        } else if (!instance.hidden && !instance.display_name) {
          await instance.destroy();
        } else {
          await instance.update({ sort_order: null });
        }
      }
      invalidateVodCache();
      return h.response({ success: true });
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/genres/{type}/{id}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const row = await GenreOverride.findByPk(genreKey(type as GenreType, id));
      if (row?.virtual) {
        // Restore items that were moved into this virtual category
        const movedItems = await ContentOverride.findAll({ where: { item_type: type, target_category_id: id } });
        for (const item of movedItems) {
          if (!item.display_name && !item.hidden) {
            await item.destroy();
          } else {
            await item.update({ target_category_id: null, original_category_id: null });
          }
        }
      }
      await GenreOverride.destroy({ where: { genre_key: genreKey(type as GenreType, id) } });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  // ── Items ───────────────────────────────────────────────────────────────────

];
