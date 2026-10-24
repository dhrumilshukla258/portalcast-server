// Answers the apps keep (infra/httpCaching.ts): a catalog answer at the current catalog version
// is kept for good; personal ones (Home, rows, recommendations) only by the Home version, which
// moves with the viewer's history (recommendations kept by the catalog version went stale).
import { test } from "node:test";
import assert from "node:assert/strict";
import Hapi from "@hapi/hapi";
import { initDB } from "../src/db";
import { loadSettings, saveSetting } from "../src/config/settings";
import { ContentMeta } from "../src/models/ContentMeta";
import { startCatalogSnapshot } from "../src/content/catalog/store";
import { registerHttpCaching } from "../src/infra/httpCaching";

test("personal answers are kept by the Home version, catalog answers by the catalog version", async () => {
  await initDB();
  await loadSettings();
  await saveSetting("catalogSnapshot", true);
  await ContentMeta.upsert({ id: "movie_1", type: "movie", name: "One", portalCategoryId: "1", groupKey: "movie:one", enrichedAt: new Date() } as any);
  await startCatalogSnapshot();

  const server = Hapi.server();
  registerHttpCaching(server);
  for (const path of ["/api/v2/movies", "/api/v2/discover/recommendations", "/api/v2/discover/rows"]) {
    server.route({ method: "GET", path, handler: () => ({ data: [path] }) });
  }
  const first = await server.inject({ method: "GET", url: "/api/v2/movies" });
  const catalog = String(first.headers["x-catalog-version"]);
  const home = String(first.headers["x-home-version"]);
  assert.ok(catalog && home && catalog !== "undefined" && home !== catalog, "both versions are sent");

  const cc = async (url: string) => String((await server.inject({ method: "GET", url })).headers["cache-control"]);
  assert.match(await cc(`/api/v2/movies?v=${catalog}`), /immutable/, "a catalog list at the catalog version");
  for (const p of ["/api/v2/discover/recommendations", "/api/v2/discover/rows"]) {
    assert.doesNotMatch(await cc(`${p}?v=${catalog}`), /immutable/, `${p} is not kept by the catalog version`);
    assert.match(await cc(`${p}?v=${home}`), /immutable/, `${p} is kept by the Home version`);
  }
  assert.doesNotMatch(await cc(`/api/v2/movies?v=${home}`), /immutable/, "and a catalog list not by the Home version");
});
