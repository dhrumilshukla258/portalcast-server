import { ServerRoute } from "@hapi/hapi";
import { channelRoutes } from "./channels";
import { movieRoutes } from "./movies";
import { seriesRoutes } from "./series";
import { epgRoutes } from "./epg";
import { downloadRoutes } from "./downloads";
import { subtitleRoutes } from "./subtitles";
import { maintenanceRoutes } from "./maintenance";
import { playlistDomainRoutes } from "./playlist";

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
