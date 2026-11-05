import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/infra/logger";
import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { readGenres, readChannels } from "@/infra/storage";
import { xtreamCache } from "@/services/xtreamCache";
import { genreKey, contentKey, overridesProfile, loadGenreOverrides, loadVirtualGenres, categoryHolds, isCategoryHolds } from "@/content/overrides";
import { peekDiscoverIndex, categoryListedUnder, categoryTypeCounts } from "@/content/discoverIndex";
import { GenreType } from "@/models/Genre";
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
      // The active provider profile's categories and overrides (owner 2026-11-04: per profile).
      const pid = await overridesProfile();
      const genres = await readGenres(genreType, pid ?? undefined);
      const ovMap = await loadGenreOverrides(genreType, genres.map((g) => String(g.id)), pid);
      // Movies / Series: what each category holds (set here; none: listed as the provider lists
      // it), and its titles of each type, to help decide.
      const vod = genreType === "movie" || genreType === "series";
      const holds = vod ? await categoryHolds(pid) : new Map();
      const counts = peekDiscoverIndex()?.categoryCounts;

      const result = await Promise.all(
        genres.map(async (g) => {
          const id = String(g.id);
          const ov = ovMap.get(genreKey(genreType, id));
          const count = await getItemCount(genreType, id);
          return {
            id,
            title: g.title,
            display_name: ov?.display_name ?? null,
            hidden: ov?.hidden ?? false,
            sort_order: (ov as any)?.sort_order ?? null,
            count,
            ...(vod && id !== "*" ? {
              holds: holds.get(id) ?? null,
              titles: categoryTypeCounts(counts, id),
              listed: categoryListedUnder(genreType as "movie" | "series", holds.get(id)),
            } : {}),
          };
        }),
      );

      // Also include virtual categories for this type
      const virtualResult = await Promise.all(
        (await loadVirtualGenres(genreType, pid)).map(async (v) => ({
          id: v.id,
          title: v.title ?? v.id,
          display_name: null,
          hidden: false,
          sort_order: v.sort_order ?? null,
          count: await getItemCount(genreType, v.id),
          virtual: true,
        })),
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
      const key = genreKey(type as GenreType, id, await overridesProfile());
      await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order: null, virtual: true, virtual_title: title.trim() });
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
      const pid = await overridesProfile();
      for (const { id, sort_order } of order) {
        const key = genreKey(type as GenreType, id, pid);
        const existing = await GenreOverride.findByPk(key);
        if (existing) {
          await existing.update({ sort_order });
        } else {
          await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order });
        }
      }
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
      const body = (request.payload ?? {}) as any;
      const pid = await overridesProfile();
      // What a provider category holds (Movies / Series / Both; "auto" or null: from its titles).
      // One setting for both lists, since they share the provider's ids. Nothing else changes.
      if ("holds" in body) {
        if (type === "channel") return h.response({ error: "Channel groups have no type" }).code(400);
        const value = body.holds == null || body.holds === "auto" ? null : body.holds;
        if (value !== null && !isCategoryHolds(value)) return h.response({ error: "holds: movie, series, both or auto" }).code(400);
        const vodKey = genreKey("vod", id, pid);
        const row = await GenreOverride.findByPk(vodKey);
        if (row) {
          if (value === null) await row.destroy();
          else await row.update({ holds: value });
        } else if (value !== null) {
          await GenreOverride.create({ genre_key: vodKey, display_name: null, hidden: false, sort_order: null, virtual: false, virtual_title: null, holds: value });
        }
        return h.response({ success: true });
      }
      const { display_name, hidden, virtual_title } = body;
      const key = genreKey(type as GenreType, id, pid);
      const existing = await GenreOverride.findByPk(key);
      if (existing?.virtual) {
        await existing.update({ virtual_title: virtual_title ?? existing.virtual_title });
      } else if (existing) {
        await existing.update({ display_name: display_name ?? null, hidden: hidden ?? false });
      } else {
        await GenreOverride.create({ genre_key: key, display_name: display_name ?? null, hidden: hidden ?? false, sort_order: null, virtual: false, virtual_title: null });
      }
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
      const pid = await overridesProfile();
      const prefixes = [genreKey(type as GenreType, "", pid), genreKey(type as GenreType, "")];
      const rows = await GenreOverride.findAll({ raw: true });
      for (const row of rows.filter((r) => prefixes.some((p) => r.genre_key.startsWith(p)))) {
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
      const pid = await overridesProfile();
      const row = (await GenreOverride.findByPk(genreKey(type as GenreType, id, pid))) ?? (await GenreOverride.findByPk(genreKey(type as GenreType, id)));
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
      await GenreOverride.destroy({ where: { genre_key: [genreKey(type as GenreType, id, pid), genreKey(type as GenreType, id)] } });
      return h.response({ success: true });
    },
  },

  // ── Items ───────────────────────────────────────────────────────────────────

];
