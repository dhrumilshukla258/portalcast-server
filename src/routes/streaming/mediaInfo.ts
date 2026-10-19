import { ServerRoute } from "@hapi/hapi";
import { authCheck } from "@/auth/jwt";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";
import { recordMediaInfo, validateReport, ensureMediaInfoLoaded, getVideoInfo, type MediaItemType } from "@/content/mediaInfo";
import { logger } from "@/infra/logger";

// Measured video quality (content/mediaInfo.ts). Any signed-in user's player reports what
// it decoded; values are range-checked and only describe the title, never the user.
export const mediaInfoRoutes: ServerRoute[] = [
  {
    method: "POST",
    path: "/api/v2/media-info",
    options: { payload: { maxBytes: 2048 } },
    handler: async (request, h) => {
      const user = authCheck(request);
      if (!user) return h.response({ error: "Unauthorized" }).code(401);
      const body = request.payload as any;
      const err = validateReport(body);
      if (err) return h.response({ error: err }).code(400);
      try {
        const profileId = (await getActiveProfileId()) ?? 0;
        const video = await recordMediaInfo(profileId, {
          itemType: body.itemType,
          itemId: String(body.itemId),
          width: Number(body.width),
          height: Number(body.height),
          fps: body.fps != null ? Number(body.fps) : null,
          codec: body.codec ?? null,
        });
        return { success: true, video };
      } catch (e: any) {
        logger.error(`[mediaInfo] record failed: ${e?.message ?? e}`);
        return h.response({ error: "Could not store media info" }).code(500);
      }
    },
  },
  {
    // ?ids=movie:123,episode:456 -> { "movie:123": {width,height,fps,codec,label}, ... }
    method: "GET",
    path: "/api/v2/media-info",
    handler: async (request, h) => {
      const user = authCheck(request);
      if (!user) return h.response({ error: "Unauthorized" }).code(401);
      const raw = String((request.query as any).ids ?? "");
      const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
      await ensureMediaInfoLoaded();
      const profileId = (await getActiveProfileId()) ?? 0;
      const out: Record<string, unknown> = {};
      for (const k of ids) {
        const [type, id] = k.split(":");
        if ((type !== "movie" && type !== "episode") || !id) continue;
        const v = getVideoInfo(profileId, type as MediaItemType, id);
        if (v) out[k] = v;
      }
      return out;
    },
  },
];
