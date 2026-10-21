import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { ContentMeta } from "@/models/ContentMeta";
import { fetchImageChoices } from "@/content/tmdb";
import { setCustomArt, setCustomArtFromTmdb, resetCustomArt, lockOf, type CustomKind } from "@/content/customArt";
import { proxiedImageUrl } from "@/providers/portalAssets";
import { getPublicOrigin } from "@/infra/publicUrl";
import { recordFromRequest } from "@/services/SecurityEvents";

// Admin "Edit images" on a detail page (content/customArt.ts). Under /api/admin/ (admin-gated
// in server.ts) and re-checked here. {id} is a content id ("movie_123", "series_L4").

const KINDS = new Set<CustomKind>(["poster", "backdrop", "logo"]);
const ID_RE = /^(movie|series)_[\w-]+$/;
const forbidden = (h: any) => h.response({ error: "Forbidden" }).code(403);

export const titleImageRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/titles/{id}/images",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const id = String(request.params.id);
      if (!ID_RE.test(id)) return h.response({ error: "Bad id" }).code(400);
      const row = await ContentMeta.findByPk(id);
      if (!row) return h.response({ error: "Unknown title" }).code(404);
      const origin = getPublicOrigin(request);
      const lock = lockOf(row);
      const choices = row.tmdbId ? await fetchImageChoices(row.type === "series" ? "tv" : "movie", Number(row.tmdbId)) : { posters: [], backdrops: [], logos: [] };
      const prev = (list: any[]) => list.map((c) => ({ ...c, preview: proxiedImageUrl(c.preview, origin) }));
      return {
        id,
        current: {
          poster: row.poster ? proxiedImageUrl(row.poster, origin) : null,
          backdrop: row.backdrop ? proxiedImageUrl(row.backdrop, origin) : null,
          logo: row.logo ? proxiedImageUrl(row.logo, origin) : null,
        },
        custom: { poster: Boolean(lock.poster), backdrop: Boolean(lock.backdrop), logo: Boolean(lock.logo) },
        choices: { posters: prev(choices.posters), backdrops: prev(choices.backdrops), logos: prev(choices.logos) },
      };
    },
  },
  {
    // Choose a TMDB alternative: { kind, tmdbPath: "/abc.jpg" }.
    method: "POST",
    path: "/api/admin/titles/{id}/images",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const id = String(request.params.id);
      const { kind, tmdbPath } = (request.payload || {}) as { kind?: CustomKind; tmdbPath?: string };
      if (!ID_RE.test(id) || !kind || !KINDS.has(kind) || !tmdbPath) return h.response({ error: "Give kind and tmdbPath" }).code(400);
      try {
        await setCustomArtFromTmdb(id, kind, tmdbPath);
      } catch (e: any) {
        return h.response({ error: String(e?.message ?? e) }).code(400);
      }
      recordFromRequest(request, "setting_changed", `${id} ${kind} chosen`, (admin as any).userId ?? null);
      return { ok: true };
    },
  },
  {
    // Upload an image as the title's poster/backdrop/logo (multipart: file, kind).
    method: "POST",
    path: "/api/admin/titles/{id}/images/upload",
    options: { payload: { output: "data", parse: true, multipart: true, maxBytes: 15 * 1024 * 1024 } },
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const id = String(request.params.id);
      const payload = (request.payload || {}) as any;
      const kind = String(payload.kind || "") as CustomKind;
      if (!ID_RE.test(id) || !KINDS.has(kind) || !Buffer.isBuffer(payload.file)) return h.response({ error: "Give kind and an image file" }).code(400);
      try {
        await setCustomArt(id, kind, payload.file);
      } catch (e: any) {
        recordFromRequest(request, "upload_rejected", `title image: ${String(e?.message ?? e).slice(0, 80)}`);
        return h.response({ error: String(e?.message ?? e) }).code(400);
      }
      recordFromRequest(request, "setting_changed", `${id} ${kind} uploaded`, (admin as any).userId ?? null);
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/titles/{id}/images/{kind}",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const id = String(request.params.id);
      const kind = String(request.params.kind) as CustomKind;
      if (!ID_RE.test(id) || !KINDS.has(kind)) return h.response({ error: "Bad request" }).code(400);
      await resetCustomArt(id, kind);
      recordFromRequest(request, "setting_changed", `${id} ${kind} reset`, (admin as any).userId ?? null);
      return { ok: true };
    },
  },
];
