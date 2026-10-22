// GET /api/v2/sports?days=30 — the Sports page (content/sports.ts): upcoming games of the
// viewer's chosen leagues (preferences.sportsLeagues; none chosen: the admin's), with the
// channels the guide shows them on. GET /api/v2/sports/leagues — every league there is, by
// sport, and which ones the viewer has. Any signed-in user (the global gate in server.ts).
import { ServerRoute } from "@hapi/hapi";
import { sportsAnswer, parseDays, CATALOGUE, leagueName, sportOf, configuredLeagues, cleanLeagueChoice } from "@/content/sports";
import { authCheck } from "@/auth/jwt";
import { User } from "@/models/User";

async function viewerLeagues(request: any): Promise<string[] | null> {
  const payload = authCheck(request);
  if (!payload || typeof payload.userId !== "number") return null;
  const user = await User.findByPk(payload.userId, { attributes: ["preferences"] });
  const choice = cleanLeagueChoice((user?.preferences as any)?.sportsLeagues);
  return choice && choice.length ? choice : null;
}

export const sportsRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/v2/sports",
    handler: async (request, h) => {
      const body = await sportsAnswer(parseDays((request.query as any).days), await viewerLeagues(request));
      // Short: the "Live" badge and the guide match move with the clock.
      return h.response(body).header("Cache-Control", "private, max-age=120");
    },
  },
  {
    method: "GET",
    path: "/api/v2/sports/leagues",
    handler: async (request) => {
      const chosen = await viewerLeagues(request);
      return {
        leagues: CATALOGUE.map((id) => ({ id, name: leagueName(id), sport: sportOf(id, leagueName(id)) })),
        chosen: chosen ?? configuredLeagues(),
        defaults: configuredLeagues(),
        max: 20,
      };
    },
  },
];
