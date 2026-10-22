// Where the server keeps its own files. Everything follows the data folder, the folder of
// the database (SQLITE_DB_PATH, a file or a folder): the database, the generated key file,
// uploads and backups. In Docker that folder is the /app/data volume, so all of it survives
// a redeploy.

import fs from "fs";
import path from "path";

function resolveDatabasePath(): string {
  const envPath = process.env.SQLITE_DB_PATH;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, "database.db");
    }
    return resolved;
  }
  // Prefer existing db file for backwards compatibility
  for (const candidate of [
    path.join(process.cwd(), "database.db"),
    path.join(process.cwd(), "database.sqlite"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), "database.db");
}

export const databasePath = resolveDatabasePath();

/** The data folder: the database's folder. Created if missing. */
export const dataDir = path.dirname(databasePath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

/**
 * Uploads (avatars; images from older versions stay served). Older setups pointed DATABASE_PATH at the database
 * file and kept uploads beside it; that still wins when set. Otherwise uploads live in the
 * data folder. Docker's default layout resolves both ways to /app/data/uploads.
 */
export const uploadsDir = process.env.DATABASE_PATH
  ? path.join(path.dirname(process.env.DATABASE_PATH), "uploads")
  : path.join(dataDir, "uploads");
