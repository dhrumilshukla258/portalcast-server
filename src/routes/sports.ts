// GET /api/v2/sports?days=7 — the Sports page (content/sports.ts): upcoming games of the
// configured leagues, with the channels the guide shows them on. Any signed-in user (the global
// gate in server.ts); nothing here is per user.
import { ServerRoute } from "@hapi/hapi";
import { sportsAnswer, parseDays } from "@/content/sports";

export const sportsRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/v2/sports",
    handler: async (request, h) => {
      const body = await sportsAnswer(parseDays((request.query as any).days));
      // Short: the "Live" badge and the guide match move with the clock.
      return h.response(body).header("Cache-Control", "private, max-age=120");
    },
  },
];
