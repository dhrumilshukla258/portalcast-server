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
import { StrmMovie } from "@/models/StrmMovie";
import { StrmSeries } from "@/models/StrmSeries";
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

  {
    // Clears the STRM tracking tables — every row here is fully re-derivable from the
    // Xtream cache on the next generate call, so this is safe as long as the on-disk
    // .strm folders are also wiped by hand first. Without wiping the folders too, the
    // next generate() will recreate every file from scratch alongside whatever's left
    // on disk, which is harmless but pointless — the point of calling this is to force
    // a clean regeneration after manually deleting the output directories.
    method: "POST",
    path: "/api/admin/strm/reset",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);

      const movieCount  = await StrmMovie.count();
      const seriesCount = await StrmSeries.count();
      const warning =
        `This will permanently clear ${movieCount} strm_movies row(s) and ${seriesCount} strm_series row(s). ` +
        "The next /api/admin/strm/generate call will then treat every movie/episode as brand new and rewrite " +
        "the entire output library from scratch. If you have NOT already manually deleted the .strm folders on " +
        "disk (STRM_MOVIES_PATH / STRM_SERIES_PATH), do that first — otherwise the old files will be orphaned " +
        "on disk with no tracking row and will never be cleaned up automatically. This action cannot be undone; " +
        "the tracking data is only re-derivable by re-running generation from the Xtream cache.";

      if (request.query.confirm !== "true") {
        return h.response({
          confirmed: false,
          warning,
          message: "Re-send this request with ?confirm=true to proceed.",
        }).code(400);
      }

      const [moviesDeleted, seriesDeleted] = await Promise.all([
        StrmMovie.destroy({ where: {}, truncate: true }),
        StrmSeries.destroy({ where: {}, truncate: true }),
      ]);
      logger.warn(`[STRM] Reset confirmed: cleared strm_movies (was ${movieCount} rows, deleted ${moviesDeleted ?? "all"}) and strm_series (was ${seriesCount} rows, deleted ${seriesDeleted ?? "all"})`);
      return h.response({
        success: true,
        message: "STRM tracking tables cleared — next /api/admin/strm/generate will rebuild everything from scratch",
      });
    },
  },

];
