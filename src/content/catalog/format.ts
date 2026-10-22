// The snapshot file: sections written as raw bytes, 8-byte aligned, after a small header.
//
//   "PCCAT01\n" (8 bytes) | header length (uint32 LE) | header JSON | padding | sections...
//
// Header: { format, version, builtAt, checksum, counts, sections: [{ name, type, offset, length }] }
// with offsets from the start of the file. Sections are written in name order; `checksum` is
// CHECKSUM (builder.ts) over the section bytes in that order, computed by the builder worker. Loading reads
// and verifies the file in a worker, then transfers the one buffer: the main thread only makes
// typed-array views over it.

import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { CHECKSUM, type Section } from "./builder";

export const FORMAT = 2; // 2: shaped list entries, sparse person details, sha1, no pool.len
const MAGIC = Buffer.from("PCCAT01\n", "ascii");

const TYPES: Record<string, { new (buf: ArrayBuffer, off: number, len: number): Section; BYTES_PER_ELEMENT: number }> = {
  Uint8Array, Uint16Array, Int16Array, Int32Array, Uint32Array, Float64Array,
};

export interface FileHeader {
  format: number;
  version: number;
  builtAt: string;
  checksum: string;
  counts: Record<string, number>;
  sections: { name: string; type: string; offset: number; length: number }[];
}

const align8 = (n: number) => (n + 7) & ~7;

/** Writes the snapshot without blocking (one async write per section); returns the file path. */
export async function writeSnapshotFile(
  dir: string,
  meta: { version: number; builtAt: string; checksum: string; counts: Record<string, number> },
  sections: Record<string, Section>,
): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const names = Object.keys(sections).sort();
  // Header size depends on the offsets it lists; offsets start after the (padded) header, so
  // reserve generously and pad.
  const draft: FileHeader = { format: FORMAT, ...meta, sections: [] };
  const reserve = align8(MAGIC.length + 4 + Buffer.byteLength(JSON.stringify(draft)) + names.length * 96 + 64);
  let offset = reserve;
  for (const name of names) {
    const s = sections[name];
    draft.sections.push({ name, type: s.constructor.name, offset, length: s.length });
    offset = align8(offset + s.byteLength);
  }
  const headerJson = Buffer.from(JSON.stringify(draft), "utf8");
  if (MAGIC.length + 4 + headerJson.length > reserve) throw new Error("snapshot header larger than reserved");
  const head = Buffer.alloc(reserve);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(headerJson.length, MAGIC.length);
  headerJson.copy(head, MAGIC.length + 4);

  const final = path.join(dir, `snapshot-${meta.version}.bin`);
  const tmp = `${final}.tmp`;
  const fh = await fs.promises.open(tmp, "w");
  try {
    await fh.write(head, 0, head.length, 0);
    for (const entry of draft.sections) {
      const s = sections[entry.name];
      await fh.write(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), 0, s.byteLength, entry.offset);
    }
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, final); // a crash mid-write never leaves a half file under the real name
  return final;
}

/** Reads and verifies a snapshot file in a worker; the buffer is transferred, not copied. */
export function readSnapshotFile(file: string): Promise<{ header: FileHeader; sections: Record<string, Section> }> {
  return new Promise((resolve, reject) => {
    const source = `
      const { parentPort, workerData } = require("worker_threads");
      const fs = require("fs"), crypto = require("crypto");
      try {
        const buf = fs.readFileSync(workerData.file);
        const magic = workerData.magic;
        if (buf.subarray(0, magic.length).toString("ascii") !== magic) throw new Error("not a snapshot file");
        const len = buf.readUInt32LE(magic.length);
        const header = JSON.parse(buf.subarray(magic.length + 4, magic.length + 4 + len).toString("utf8"));
        if (header.format !== workerData.format) throw new Error("snapshot format " + header.format + ", expected " + workerData.format);
        const hash = crypto.createHash(workerData.checksum);
        for (const s of header.sections) hash.update(buf.subarray(s.offset, s.offset + s.length * workerData.sizes[s.type]));
        if (hash.digest("hex") !== header.checksum) throw new Error("snapshot checksum mismatch");
        // A private ArrayBuffer (readFileSync's may be pooled) that can be transferred.
        const ab = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        parentPort.postMessage({ header, ab }, [ab]);
      } catch (e) {
        parentPort.postMessage({ error: String(e && e.message || e) });
      }`;
    const sizes = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.BYTES_PER_ELEMENT]));
    const worker = new Worker(source, { eval: true, workerData: { file, magic: MAGIC.toString("ascii"), format: FORMAT, sizes, checksum: CHECKSUM } });
    let done = false;
    worker.once("message", (m: any) => {
      done = true;
      if (m.error) return reject(new Error(m.error));
      const sections: Record<string, Section> = {};
      for (const s of (m.header as FileHeader).sections) {
        const Ctor = TYPES[s.type];
        if (!Ctor) return reject(new Error(`unknown section type ${s.type}`));
        sections[s.name] = new Ctor(m.ab, s.offset, s.length);
      }
      resolve({ header: m.header, sections });
    });
    worker.once("error", (e) => { if (!done) { done = true; reject(e); } });
    worker.once("exit", (code) => { if (!done) { done = true; reject(new Error(`snapshot reader exited (${code})`)); } });
  });
}

/** Saved snapshot files in `dir`, newest version first. */
export async function listSnapshotFiles(dir: string): Promise<{ file: string; version: number }[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  return names
    .map((n) => /^snapshot-(\d+)\.bin$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ file: path.join(dir, m[0]), version: Number(m[1]) }))
    .sort((a, b) => b.version - a.version);
}
