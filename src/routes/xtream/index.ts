import { ServerRoute } from "@hapi/hapi";
import { protocolRoutes } from "./protocol";
import { streamRoutes } from "./streams";

export const xtreamRoutes: ServerRoute[] = [...protocolRoutes, ...streamRoutes];
