// "Sign in with Jellyfin" and direct streams (routes/account/auth.ts, content/library/jellyfin.ts,
// content/library/catalog.ts localPlayLink) against a stand-in Jellyfin.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JELLYFIN_URL = "http://jellyfin:8096";
process.env.JELLYFIN_API_KEY = "server-api-key";

const ITEM = "a1".repeat(16);
const SRC = "b2".repeat(16);
let tokenValid = true;

async function fakeJellyfin(input: any, init: any): Promise<Response> {
  const u = new URL(String(input));
  if (u.pathname === "/Users/AuthenticateByName") {
    const { Username, Pw } = JSON.parse(String(init.body));
    if (Pw !== "right") return new Response("", { status: 401 });
    const id = Username === "anna" ? "c3".repeat(16) : "d4".repeat(16);
    return Response.json({ User: { Id: id, Name: Username === "anna" ? "Anna" : "Ben", Policy: { IsAdministrator: false, IsDisabled: false } }, AccessToken: `tok${Username}0123456789` });
  }
  if (u.pathname === "/Users/Me") return new Response("{}", { status: tokenValid ? 200 : 401 });
  return new Response("", { status: 404 });
}

test("Sign in with Jellyfin: approval, allow, and direct streams with the viewer's own token", async () => {
  const { initDB } = await import("../src/db");
  const { loadSettings, saveSetting } = await import("../src/config/settings");
  await initDB();
  await loadSettings();
  const { setJellyfinTransport } = await import("../src/content/library/jellyfin");
  setJellyfinTransport(fakeJellyfin as any);
  const Hapi = await import("@hapi/hapi");
  const { authRoutes } = await import("../src/routes/account/auth");
  const server = Hapi.server();
  server.route(authRoutes);
  const signIn = (username: string, password: string) =>
    server.inject({ method: "POST", url: "/api/auth/jellyfin", payload: { username, password } });

  // Off until an admin turns it on.
  assert.equal((await signIn("anna", "right")).statusCode, 404);
  await saveSetting("jellyfinSignIn", true);
  assert.equal(JSON.parse((await server.inject({ method: "GET", url: "/api/auth/jellyfin/enabled" })).payload).enabled, true);

  assert.equal((await signIn("anna", "wrong")).statusCode, 401);
  // A new person waits for an admin (the default).
  assert.equal((await signIn("anna", "right")).statusCode, 403);
  const { User } = await import("../src/models/User");
  const anna = await User.findOne({ where: { jellyfinUserId: "c3".repeat(16) } });
  assert.equal(anna!.isActive, false);
  assert.equal(anna!.name, "Anna");
  assert.ok(anna!.jellyfinTokenEnc && !anna!.jellyfinTokenEnc.includes("tokanna")); // stored encrypted

  // "allow": straight in.
  await saveSetting("jellyfinNewUsers", "allow");
  const ok = await signIn("ben", "right");
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.payload);
  assert.ok(body.accessToken && body.refreshToken);
  assert.equal(body.user.name, "Ben");

  // A Jellyfin file plays straight from Jellyfin's address for apps, with Ben's own token.
  await saveSetting("jellyfinAppUrl", "http://192.168.1.10:8096");
  const { LocalItem } = await import("../src/models/LocalItem");
  const { MediaFile } = await import("../src/models/MediaFile");
  const item = await LocalItem.create({ libraryId: 1, kind: "movie", root: "jellyfin", relPath: ITEM, name: "Heat", missingSince: null } as any);
  const file = await MediaFile.create({ itemId: item.id, libraryId: 1, root: "jellyfin", relPath: `${ITEM}/${SRC}`, size: 1, mtimeMs: 0, videoCodec: "h264", container: "mkv", audioTracks: [{ index: 1, codec: "aac" }], missingSince: null } as any);
  const { localPlayLink } = await import("../src/content/library/catalog");
  const direct = String(await localPlayLink(`LF${file.id}`, "ben", "Heat", "web", body.user.id));
  assert.match(direct, new RegExp(`^http://192\\.168\\.1\\.10:8096/Videos/${ITEM}/stream\\?static=true&mediaSourceId=${SRC}&ApiKey=tokben0123456789&t=\\w+&lib=1$`));
  assert.ok(!direct.includes("server-api-key")); // never the server's key

  // No Jellyfin login (Anna is not signed in here), or turned off: through this server.
  assert.match(String(await localPlayLink(`LF${file.id}`, "x", "Heat", "web")), /^\/api\/local\/stream\?t=/);
  await saveSetting("jellyfinDirectStreams", false);
  assert.match(String(await localPlayLink(`LF${file.id}`, "ben", "Heat", "web", body.user.id)), /^\/api\/local\/stream\?t=/);
  setJellyfinTransport(null);
  tokenValid = true;
});
