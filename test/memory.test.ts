// Memory for Admin > Overview and the 30-minute log line (infra/memory.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryNow } from "../src/infra/memory";

test("memory in use is reported, and never more than resident", () => {
  const m = memoryNow();
  for (const [k, v] of Object.entries(m)) assert.ok(Number.isInteger(v) && v >= 0, `${k} = ${v}`);
  assert.ok(m.inUseMb > 0);
  // Linux: its own memory only; elsewhere the resident size itself.
  assert.ok(m.inUseMb <= m.residentMb + 1);
  assert.ok(m.heapUsedMb <= m.heapTotalMb);
});
