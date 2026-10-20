import { serverSecret } from "@/infra/serverSecret";
import crypto from "crypto";

// Reversible encryption for credentials we must hand back to a third party
// verbatim (OpenSubtitles has no refresh-token flow — only re-login with the
// original password), saved settings and provider credentials. Key is derived
// from the server secret (JWT_SECRET, or the generated key file) via SHA-256.
const KEY = crypto.createHash("sha256").update(serverSecret).digest();

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}
