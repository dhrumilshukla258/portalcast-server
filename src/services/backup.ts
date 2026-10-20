// Nightly database backup: a consistent copy made with SQLite's VACUUM INTO (safe while the
// server keeps writing; WAL readers do not block writers), kept for the last N days.
//
// The key file (secret.key) is deliberately not copied: a backup that sits next to its key
// would expose every saved secret to anyone who can read the backup folder.

import fs from "fs";
import path from "path";
import { sequelize } from "@/db";
import { dataDir } from "@/infra/paths";
import { setting } from "@/config/settings";
import { logger } from "@/infra/logger";

const NAME_RE = /^portalcast-(\d{4}-\d{2}-\d{2})\.db$/;

export function backupFolder(): string {
  const configured = String(setting<string>("backupFolder") || "").trim();
  return configured ? path.resolve(configured) : path.join(dataDir, "backups");
}

export async function backupDatabase(): Promise<string> {
  const keep = setting<number>("backupKeep");
  if (keep <= 0) return "backups are off (keep = 0)";
  const dir = backupFolder();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(dir, `portalcast-${day}.db`);
  const temp = `${target}.partial`;
  try { fs.rmSync(temp, { force: true }); } catch { /* none */ }

  const started = Date.now();
  // VACUUM INTO refuses an existing file: write to a temporary name, then swap it in.
  await sequelize.query("VACUUM INTO ?", { replacements: [temp] });
  fs.renameSync(temp, target);
  const bytes = fs.statSync(target).size;

  const old = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse().slice(keep);
  for (const f of old) {
    try { fs.rmSync(path.join(dir, f)); } catch (e: any) { logger.warn(`[backup] could not remove ${f}: ${e?.message ?? e}`); }
  }
  const summary = `${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s, ${old.length} old backup(s) removed`;
  logger.info(`[backup] database copied to ${target} (${summary})`);
  return summary;
}
