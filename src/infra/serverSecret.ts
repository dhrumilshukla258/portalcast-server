// The server's own secret: signs logins (JWT), encrypts saved secrets (auth/crypto.ts) and
// signs image-proxy links. Like Jellyfin, it no longer has to be configured: if JWT_SECRET is
// set, that value is used (existing installs keep every login and encrypted value); if not,
// a random key is generated once and kept in the data folder as `secret.key`.
//
// Keep that file with your backups but not inside them: the nightly database backup
// deliberately leaves it out, because a backup next to its key exposes every saved secret.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataDir } from "@/infra/paths";

export const SECRET_FILE = path.join(dataDir, "secret.key");

function resolveSecret(): { value: string; source: "environment" | "file" | "generated" } {
  const env = process.env.JWT_SECRET;
  if (env) return { value: env, source: "environment" };
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf-8").trim();
    if (existing.length >= 32) return { value: existing, source: "file" };
  } catch {
    /* not there yet */
  }
  const generated = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(SECRET_FILE, generated + "\n", { mode: 0o600 });
  return { value: generated, source: "generated" };
}

const resolved = resolveSecret();

/** The secret all signing and encryption derives from. */
export const serverSecret: string = resolved.value;
/** Where it came from, for the admin page and the startup log. */
export const serverSecretSource = resolved.source;
