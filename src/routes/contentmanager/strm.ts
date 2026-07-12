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
export const strmRoutes: ServerRoute[] = [
  {
    method: "POST",
    path: "/api/admin/strm/generate",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const moviesPath = process.env.STRM_MOVIES_PATH;
      const seriesPath = process.env.STRM_SERIES_PATH;
      if (!moviesPath && !seriesPath) {
        return h.response({ error: "STRM_MOVIES_PATH and STRM_SERIES_PATH are not configured" }).code(400);
      }
      // Run in background, respond immediately
      generateStrmFiles().catch((e) => logger.error({ err: e }, "[STRM] generate error"));
      return h.response({ success: true, message: "STRM generation started in background" });
    },
  },

];
