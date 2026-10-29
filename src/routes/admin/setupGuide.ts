import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { setting } from "@/config/settings";
import { ConfigProfile } from "@/models/ConfigProfile";
import { Library } from "@/models/Library";
import { User } from "@/models/User";
import { SystemConfig } from "@/models/SystemConfig";
import { jellyfinConfig } from "@/content/library/jellyfin";
import { serverOpenSubtitlesKey } from "@/content/subtitleKeys";

// The setup guide on Admin › Overview (owner 2026-10-29: "after setup, a first-time onboarding
// over everything the server needs"): what is done, so the guide can tick it and lead to
// the rest. It shows until the admin finishes or dismisses it; it can be opened again.

const DISMISSED = "setupGuide:dismissed";

export const setupGuideRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/setup-guide",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const [profiles, libraries, users, dismissed] = await Promise.all([
        ConfigProfile.count(),
        Library.count({ where: { enabled: true } }),
        User.count({ where: { role: "user" } }),
        SystemConfig.findByPk(DISMISSED),
      ]);
      return {
        dismissed: Boolean((dismissed?.value as any)?.v),
        steps: {
          admin: true,
          provider: profiles > 0,
          jellyfin: jellyfinConfig() !== null,
          jellyfinSignIn: Boolean(setting<boolean>("jellyfinSignIn")),
          libraries: libraries > 0,
          tmdb: Boolean(setting<string>("tmdbToken")),
          subtitles: Boolean(serverOpenSubtitlesKey()),
          users: users > 0,
        },
      };
    },
  },
  {
    method: "PUT",
    path: "/api/admin/setup-guide",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const dismissed = Boolean((request.payload as any)?.dismissed);
      await SystemConfig.upsert({ key: DISMISSED, value: { v: dismissed } } as any);
      return { dismissed };
    },
  },
];
