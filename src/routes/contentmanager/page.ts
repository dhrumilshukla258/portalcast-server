import { ServerRoute } from "@hapi/hapi";
import { ADMIN_HTML } from "./adminPage.template";
export const pageRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/contentmanager",
    handler: (_request, h) =>
      h.response(ADMIN_HTML).type("text/html"),
  },

  // ── Genres ─────────────────────────────────────────────────────────────────


];
