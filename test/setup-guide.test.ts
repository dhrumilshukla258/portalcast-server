// The setup guide on Admin › Overview (routes/admin/setupGuide.ts): admins only, what is done,
// and "dismissed" kept until reopened.
import { test } from "node:test";
import assert from "node:assert/strict";

test("setup guide: admin only, steps, dismissed", async () => {
  const { initDB } = await import("../src/db");
  const { loadSettings, saveSetting } = await import("../src/config/settings");
  await initDB();
  await loadSettings();
  const { createJWT } = await import("../src/auth/jwt");
  const { User } = await import("../src/models/User");
  const admin = await User.create({ email: "a@example.com", name: "A", role: "admin", isActive: true } as any);
  const user = await User.create({ email: "u@example.com", name: "U", role: "user", isActive: true } as any);
  const Hapi = await import("@hapi/hapi");
  const { setupGuideRoutes } = await import("../src/routes/admin/setupGuide");
  const server = Hapi.server();
  server.route(setupGuideRoutes);
  const as = (u: any) => ({ authorization: `Bearer ${createJWT({ userId: u.id, email: u.email, role: u.role }, 600)}` });

  assert.equal((await server.inject({ method: "GET", url: "/api/admin/setup-guide", headers: as(user) })).statusCode, 403);
  let g = JSON.parse((await server.inject({ method: "GET", url: "/api/admin/setup-guide", headers: as(admin) })).payload);
  assert.equal(g.dismissed, false);
  assert.deepEqual([g.steps.admin, g.steps.provider, g.steps.tmdb, g.steps.users], [true, false, false, true]);

  await saveSetting("tmdbToken", "a-token-for-the-test-only");
  await server.inject({ method: "PUT", url: "/api/admin/setup-guide", headers: as(admin), payload: { dismissed: true } });
  g = JSON.parse((await server.inject({ method: "GET", url: "/api/admin/setup-guide", headers: as(admin) })).payload);
  assert.equal(g.steps.tmdb, true);
  assert.equal(g.dismissed, true);
});
