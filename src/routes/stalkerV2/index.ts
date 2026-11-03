import { ServerRoute } from "@hapi/hapi";
import { channelRoutes } from "./channels";
import { movieRoutes } from "./movies";
import { seriesRoutes } from "./series";
import { epgRoutes } from "./epg";
import { downloadRoutes } from "./downloads";
import { subtitleRoutes } from "./subtitles";
import { maintenanceRoutes } from "./maintenance";
import { playlistDomainRoutes } from "./playlist";
import { wrapRoute, mergeSeriesHandler, mergeMoviesHandler } from "./seasonMerge";

// Shows listed one season at a time are served as one show (seasonMerge.ts).
wrapRoute(seriesRoutes, "/api/v2/series", mergeSeriesHandler);
wrapRoute(movieRoutes, "/api/v2/movies", mergeMoviesHandler);

export const stalkerV2: ServerRoute[] = [
  ...channelRoutes,
  ...movieRoutes,
  ...seriesRoutes,
  ...epgRoutes,
  ...downloadRoutes,
  ...subtitleRoutes,
  ...maintenanceRoutes,
  ...playlistDomainRoutes,
];
