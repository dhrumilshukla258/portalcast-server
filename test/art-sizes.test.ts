import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { scaledArt } from "../src/content/library/artSizes";

// Without ffmpeg (or when it fails) the original is served: scaledArt answers null, leaves no
// partial file, and only the three card/backdrop widths are ever made.

test("an unsupported width or a failed conversion serves the original", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-art-"));
  const src = path.join(dir, "poster.jpg");
  fs.writeFileSync(src, "not really an image");
  assert.equal(await scaledArt(src, "12.poster.1.sig", 500), null, "500 is not a card or backdrop width");
  const out = await scaledArt(src, "12.poster.1.sig", 342);
  assert.equal(out, null, "not an image (or no ffmpeg here): the original is served");
  const local = path.join(process.env.SQLITE_DB_PATH!, "image-cache", "local");
  const parts = fs.existsSync(local) ? fs.readdirSync(local, { recursive: true }).map(String).filter((f) => f.endsWith(".part.jpg")) : [];
  assert.deepEqual(parts, [], "no half-made file left behind");
});
