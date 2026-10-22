import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";
import { initialConfig } from "../src/config/server";
import { StalkerAPI } from "../src/providers/stalker";

// Plan Phase 5: the same play link asked for at the same moment (two TVs, a double press) is
// one portal call that both wait on; it is not cached, so a later request asks again.

test("simultaneous identical play-link requests share one portal call; later ones ask again", async () => {
  let linkCalls = 0;
  const server = http.createServer((req, res) => {
    const action = new URL(req.url ?? "/", "http://x").searchParams.get("action");
    if (action === "create_link") linkCalls++;
    setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ js: { cmd: `ffmpeg http://cdn.invalid/movie.mp4?n=${linkCalls}` } }));
    }, 80);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  Object.assign(initialConfig, { hostname: "127.0.0.1", port, contextPath: "" });
  const api = new StalkerAPI();
  (api as any).cache.set("auth_token", "test-token", 3600); // no handshake against the test server
  try {
    const ask = () => api.getMovieLink({ series: "0", id: 42, download: 0 });
    const [a, b, c] = await Promise.all([ask(), ask(), ask()]);
    assert.equal(linkCalls, 1, "three at once: one portal call");
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    await ask();
    assert.equal(linkCalls, 2, "after it answered: a new call (links are not cached)");
    await Promise.all([api.getMovieLink({ series: "0", id: 42, download: 0 }), api.getMovieLink({ series: "0", id: 43, download: 0 })]);
    assert.equal(linkCalls, 4, "different titles: separate calls");
  } finally {
    server.close();
  }
});
