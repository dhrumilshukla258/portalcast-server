import { test } from "node:test";
import assert from "node:assert/strict";
import { isProviderDown, providerDownBody } from "../src/streaming/providerDown";

test("unreachable provider errors are told apart from other failures", () => {
  assert.equal(isProviderDown(new Error("StalkerAPI circuit breaker is open — upstream provider is unavailable")), true);
  assert.equal(isProviderDown(Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:80"), { code: "ECONNREFUSED" })), true);
  assert.equal(isProviderDown(new Error("timeout of 10000ms exceeded")), true);
  assert.equal(isProviderDown(Object.assign(new Error("x"), { cause: { code: "ETIMEDOUT" } })), true);
  assert.equal(isProviderDown(new Error("Authorization Failed.")), false);
  assert.equal(isProviderDown(new Error("Cannot read properties of undefined")), false);
  assert.equal(isProviderDown(null), false);
  assert.equal(providerDownBody().code, "provider_unavailable");
});
