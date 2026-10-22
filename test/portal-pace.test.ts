// Background portal requests are queued, paced and wait out 429s (services/portalPace.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";

process.env.PORTAL_BACKGROUND_GAP_MS = "30";
import { inBackground, pacedRequest, portalPaceState, resetPortalPaceForTests } from "../src/services/portalPace";

const tooMany = (retryAfter?: string) =>
  new AxiosError("Request failed with status code 429", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 429, statusText: "", data: "", config: {} as any, headers: retryAfter ? { "retry-after": retryAfter } : {},
  } as any);

beforeEach(() => resetPortalPaceForTests());

test("background requests go one at a time with the pause between", async () => {
  let running = 0, most = 0;
  const starts: number[] = [];
  const send = async () => {
    starts.push(Date.now());
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return "ok";
  };
  await inBackground(() => Promise.all([1, 2, 3, 4].map(() => pacedRequest("x", send))));
  assert.equal(most, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 30, `gap ${starts[i] - starts[i - 1]}`);
});

test("a 429 pauses the queue for Retry-After, then the request is sent again", async () => {
  let calls = 0;
  const t0 = Date.now();
  const out = await inBackground(() => pacedRequest("x", async (background) => {
    assert.equal(background, true);
    if (++calls === 1) throw tooMany("0.2");
    return "ok";
  }));
  assert.equal(out, "ok");
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 200);
  assert.equal(portalPaceState()[0].strikes, 1);
  assert.ok(portalPaceState()[0].gapMs >= 1000, "slower after a 429");
});

test("what a person waits on is never queued, but its 429 pauses the background", async () => {
  await assert.rejects(pacedRequest("x", async (background) => { assert.equal(background, false); throw tooMany("5"); }));
  assert.ok(portalPaceState()[0].pausedForMs > 4000);
  const t0 = Date.now();
  assert.equal(await pacedRequest("x", async () => "now"), "now");
  assert.ok(Date.now() - t0 < 100);
});

test("other errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(inBackground(() => pacedRequest("x", async () => { calls++; throw new Error("boom"); })));
  assert.equal(calls, 1);
  assert.equal(portalPaceState()[0].strikes, 0);
});

test("a portal that says too many requests does not slow another one", async () => {
  await assert.rejects(pacedRequest("x", async () => { throw tooMany("5"); }));
  const t0 = Date.now();
  assert.equal(await inBackground(() => pacedRequest("y", async () => "y answers")), "y answers");
  assert.ok(Date.now() - t0 < 100);
  assert.equal(portalPaceState().length, 2);
});
