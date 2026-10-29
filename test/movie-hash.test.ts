// OpenSubtitles' file hash (content/movieHash.ts): size + the two 64 KB ends as little-endian
// 64-bit words, summed modulo 2^64.
import { test } from "node:test";
import assert from "node:assert/strict";
import { movieHash } from "../src/content/movieHash";

test("the hash is the size plus the 64-bit words of both ends, wrapping at 2^64", () => {
  const zero = Buffer.alloc(65536);
  assert.equal(movieHash(1_000_000, zero, zero), (1_000_000).toString(16).padStart(16, "0"));
  const one = Buffer.alloc(65536);
  one.writeBigUInt64LE(1n, 0);
  assert.equal(movieHash(0, one, one), "0000000000000002");
  const max = Buffer.alloc(65536);
  max.writeBigUInt64LE((1n << 64n) - 1n, 0);
  assert.equal(movieHash(2, max, zero), "0000000000000001"); // wraps
});
