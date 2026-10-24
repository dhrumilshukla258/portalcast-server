import fs from "fs";

/**
 * What the server process holds, in MB. "In use" is its own memory: on Linux (Docker, the
 * .deb) RssAnon from /proc/self/status, what a container's limit counts; elsewhere the resident
 * size. Resident also counts the program's files the system can take back (about 240 MB on
 * the NAS), so it reads high and barely moves. Buffers hold the in-memory catalog.
 */
export function memoryNow(): { inUseMb: number; residentMb: number; heapUsedMb: number; heapTotalMb: number; buffersMb: number; nativeMb: number } {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  let own: number | null = null;
  try {
    const kb = /RssAnon:\s+(\d+) kB/.exec(fs.readFileSync("/proc/self/status", "utf8"));
    if (kb) own = Number(kb[1]) * 1024;
  } catch {
    /* not Linux */
  }
  return {
    inUseMb: mb(own ?? m.rss),
    residentMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    buffersMb: mb(m.arrayBuffers),
    nativeMb: mb(Math.max(0, m.external - m.arrayBuffers)),
  };
}
