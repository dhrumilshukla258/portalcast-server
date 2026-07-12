import { ServerRoute } from "@hapi/hapi";
import { pageRoutes } from "./page";
import { genreRoutes } from "./genres";
import { itemRoutes } from "./items";
import { strmRoutes } from "./strm";

export const adminRoutes: ServerRoute[] = [
  ...pageRoutes,
  ...genreRoutes,
  ...itemRoutes,
  ...strmRoutes,
];
