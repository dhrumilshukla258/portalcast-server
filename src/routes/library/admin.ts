import { ServerRoute } from "@hapi/hapi";
import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import { requireAdmin } from "@/auth/jwt";
import { setting } from "@/config/settings";
import { Library } from "@/models/Library";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile } from "@/models/MediaFile";
import { ContentMeta } from "@/models/ContentMeta";
import { scanLibraries, isScanning, removeLibraryContent, fixMatch, localContentId } from "@/content/library/scanner";
import { searchTmdbCandidates } from "@/content/tmdb";
import { recordFromRequest } from "@/services/SecurityEvents";
import { logger } from "@/infra/logger";

// Admin › Libraries (docs/skill-local-library.md). Under /api/admin/ (admin-gated in
// server.ts) and re-checked here. Folders must sit under one of the media roots (the
// "mediaRoots" setting, default /media: the NAS mount in the compose file); the folder
// browser shows only directories below those roots.

function roots(): string[] {
  return (setting<string[]>("mediaRoots") || []).map((r) => path.resolve(r));
}

/** The real path of `p` when it is an existing directory under a media root, else null. */
function allowedDir(p: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(p));
    if (!fs.statSync(real).isDirectory()) return null;
    const ok = roots().some((r) => {
      let rr = r;
      try { rr = fs.realpathSync(r); } catch { /* root missing */ }
      return real === rr || real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
    });
    return ok ? real : null;
  } catch {
    return null;
  }
}

async function describe(lib: Library) {
  const [items, unmatched, missing, files] = await Promise.all([
    LocalItem.count({ where: { libraryId: lib.id, missingSince: null } }),
    LocalItem.count({ where: { libraryId: lib.id, missingSince: null, matchedTmdbId: null } }),
    LocalItem.count({ where: { libraryId: lib.id, missingSince: { [Op.ne]: null } } }),
    MediaFile.count({ where: { libraryId: lib.id, missingSince: null } }),
  ]);
  return {
    id: lib.id, name: lib.name, kind: lib.kind, folders: lib.folders || [], enabled: lib.enabled,
    lastScanAt: lib.lastScanAt, lastScanSummary: lib.lastScanSummary,
    counts: { titles: items, files, unmatched, missing },
  };
}

function cleanFolders(raw: unknown): { folders: string[]; error?: string } {
  const list = (Array.isArray(raw) ? raw : []).map((f) => String(f || "").trim()).filter(Boolean);
  if (list.length === 0) return { folders: [], error: "Pick at least one folder" };
  const out: string[] = [];
  for (const f of list) {
    const ok = allowedDir(f);
    if (!ok) return { folders: [], error: `"${f}" is not a folder under the media roots (${roots().join(", ") || "none set"})` };
    if (!out.includes(ok)) out.push(ok);
  }
  return { folders: out };
}

const forbidden = (h: any) => h.response({ error: "Forbidden" }).code(403);

export const libraryAdminRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/libraries",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const libs = await Library.findAll({ order: [["id", "ASC"]] });
      return { scanning: isScanning(), roots: roots(), items: await Promise.all(libs.map(describe)) };
    },
  },
  {
    method: "POST",
    path: "/api/admin/libraries",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const body = (request.payload || {}) as any;
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return h.response({ error: "Give the library a name" }).code(400);
      const { folders, error } = cleanFolders(body.folders);
      if (error) return h.response({ error }).code(400);
      const kind = body.kind === "series" ? "series" : "movies";
      const lib = await Library.create({ name, kind, folders, enabled: true });
      recordFromRequest(request, "setting_changed", `library ${lib.id} created`, (admin as any).userId ?? null);
      scanLibraries(lib.id).catch((e) => logger.error(`[library] first scan of ${lib.name} failed: ${e?.message ?? e}`));
      return describe(lib);
    },
  },
  {
    method: "PUT",
    path: "/api/admin/libraries/{id}",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const lib = await Library.findByPk(Number(request.params.id));
      if (!lib) return h.response({ error: "No such library" }).code(404);
      const body = (request.payload || {}) as any;
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 80);
        if (!name) return h.response({ error: "Give the library a name" }).code(400);
        lib.name = name;
      }
      if (body.folders !== undefined) {
        const { folders, error } = cleanFolders(body.folders);
        if (error) return h.response({ error }).code(400);
        lib.folders = folders;
      }
      if (body.enabled !== undefined) lib.enabled = Boolean(body.enabled);
      await lib.save();
      recordFromRequest(request, "setting_changed", `library ${lib.id} changed`, (admin as any).userId ?? null);
      return describe(lib);
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/libraries/{id}",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const lib = await Library.findByPk(Number(request.params.id));
      if (!lib) return h.response({ error: "No such library" }).code(404);
      if (isScanning()) return h.response({ error: "A scan is running; try again when it ends" }).code(409);
      await removeLibraryContent(lib.id);
      await lib.destroy();
      recordFromRequest(request, "setting_changed", `library ${request.params.id} deleted`, (admin as any).userId ?? null);
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/api/admin/libraries/{id}/scan",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const id = request.params.id === "all" ? undefined : Number(request.params.id);
      if (isScanning()) return { started: false, scanning: true };
      scanLibraries(id).catch((e) => logger.error(`[library] scan failed: ${e?.message ?? e}`));
      return { started: true, scanning: true };
    },
  },
  {
    // Folder browser: the media roots, or the sub-folders of one folder under them.
    method: "GET",
    path: "/api/admin/libraries/browse",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const p = String((request.query as any)?.path || "").trim();
      if (!p) return { path: null, parent: null, folders: roots().map((r) => ({ name: r, path: r, exists: fs.existsSync(r) })) };
      const dir = allowedDir(p);
      if (!dir) return h.response({ error: "Not a folder under the media roots" }).code(400);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return h.response({ error: "That folder cannot be read" }).code(400);
      }
      const folders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return { path: dir, parent: allowedDir(parent) && parent !== dir ? parent : null, folders };
    },
  },
  {
    // Titles of a library: unmatched first, for "Fix match".
    method: "GET",
    path: "/api/admin/libraries/{id}/items",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const q = request.query as any;
      const where: any = { libraryId: Number(request.params.id) };
      if (q.filter === "unmatched") Object.assign(where, { matchedTmdbId: null, missingSince: null });
      else if (q.filter === "missing") where.missingSince = { [Op.ne]: null };
      const items = await LocalItem.findAll({ where, order: [["matchedTmdbId", "ASC"], ["name", "ASC"]], limit: 500 });
      const metas = await ContentMeta.findAll({ where: { id: { [Op.in]: items.map((i) => localContentId(i.id, i.kind)) } }, attributes: ["id", "poster", "year", "trimmedName"] });
      const metaById = new Map(metas.map((m) => [m.id, m]));
      const term = String(q.q || "").toLowerCase().trim();
      return {
        items: items
          .filter((i) => !term || i.name.toLowerCase().includes(term) || i.relPath.toLowerCase().includes(term))
          .map((i) => {
            const m = metaById.get(localContentId(i.id, i.kind));
            return {
              id: i.id, kind: i.kind, name: i.name, year: i.year, folder: i.relPath, matchedTmdbId: i.matchedTmdbId,
              locked: i.tmdbIdLocked != null, missingSince: i.missingSince, poster: m?.poster ?? null,
              matchedTitle: m?.trimmedName ?? null, matchedYear: m?.year ?? null,
            };
          }),
      };
    },
  },
  {
    method: "GET",
    path: "/api/admin/libraries/match-search",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const q = request.query as any;
      const query = String(q.q || "").trim();
      if (!query) return { items: [] };
      return { items: await searchTmdbCandidates(q.kind === "series" ? "tv" : "movie", query, q.year ? String(q.year) : null) };
    },
  },
  {
    method: "POST",
    path: "/api/admin/libraries/items/{itemId}/match",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const raw = (request.payload as any)?.tmdbId;
      const tmdbId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
      if (tmdbId !== null && (!Number.isInteger(tmdbId) || tmdbId <= 0)) return h.response({ error: "Bad TMDB id" }).code(400);
      const item = await fixMatch(Number(request.params.itemId), tmdbId);
      if (!item) return h.response({ error: "No such title" }).code(404);
      recordFromRequest(request, "setting_changed", `library title ${item.id} matched to ${tmdbId ?? "auto"}`, (admin as any).userId ?? null);
      return { id: item.id, matchedTmdbId: item.matchedTmdbId, locked: item.tmdbIdLocked != null };
    },
  },
];
