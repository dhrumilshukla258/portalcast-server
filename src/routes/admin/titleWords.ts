import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { ConfigProfile } from "@/models/ConfigProfile";
import { describeTitleWords, saveEdits, TitleWordsError } from "@/content/titleWords";
import { recordFromRequest } from "@/services/SecurityEvents";
import { logger } from "@/infra/logger";

// Admin → a portal profile → Title words: the default lists title cleaning uses (languages,
// tags, channel names; content/titleWords.ts) and this profile's changes to them. Under
// /api/admin/ (admin-gated in server.ts) and re-checked here.
const profileOf = async (raw: string) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && (await ConfigProfile.findByPk(id, { attributes: ["id"] })) ? id : null;
};

export const titleWordsRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/title-words/{profileId}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const id = await profileOf(String(request.params.profileId));
      if (!id) return h.response({ error: "Unknown profile" }).code(404);
      return describeTitleWords(id);
    },
  },
  {
    method: "PUT",
    path: "/api/admin/title-words/{profileId}",
    options: { payload: { maxBytes: 256 * 1024 } },
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return h.response({ error: "Forbidden" }).code(403);
      const id = await profileOf(String(request.params.profileId));
      if (!id) return h.response({ error: "Unknown profile" }).code(404);
      try {
        await saveEdits(id, request.payload);
      } catch (e: any) {
        if (e instanceof TitleWordsError) return h.response({ error: e.message }).code(400);
        throw e;
      }
      recordFromRequest(request, "setting_changed", `title words of profile ${id} saved`, (admin as any).userId ?? null);
      logger.info(`[title-words] profile ${id} changed in the admin page`);
      return describeTitleWords(id);
    },
  },
];
