// IPTV provider credentials are stored encrypted inside `config_profiles.config` and never
// sent back to the admin page in full.
//
// At rest: each field below is stored as "enc:<AES-GCM>" (auth/crypto.ts, the same key as
// every other stored secret). The ConfigProfile model encrypts on write and decrypts on
// read, so code that uses `profile.config` sees plain values, as before.
//
// Over the API: the password goes out as PASSWORD_PLACEHOLDER. A form that sends the
// placeholder back keeps the stored password; anything else replaces it. The MAC address,
// device ids, serial and user name stay visible to admins (they edit them), only encrypted
// at rest.

import { encryptSecret, decryptSecret } from "@/auth/crypto";
import type { Config } from "@/types/domain";

const ENCRYPTED_FIELDS = ["password", "username", "mac", "deviceId1", "deviceId2", "serialNumber"] as const;
const PREFIX = "enc:";
export const PASSWORD_PLACEHOLDER = "********";

/** Plain config -> config as stored (credential fields encrypted). */
export function encryptConfig(config: any): any {
  if (!config || typeof config !== "object") return config;
  const out = { ...config };
  for (const f of ENCRYPTED_FIELDS) {
    const v = out[f];
    if (typeof v === "string" && v !== "" && !v.startsWith(PREFIX)) out[f] = PREFIX + encryptSecret(v);
  }
  return out;
}

/** Stored config -> plain config. A value that cannot be decrypted becomes "". */
export function decryptConfig(stored: any): any {
  let config = stored;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { return config; }
  }
  if (!config || typeof config !== "object") return config;
  const out = { ...config };
  for (const f of ENCRYPTED_FIELDS) {
    const v = out[f];
    if (typeof v === "string" && v.startsWith(PREFIX)) {
      try { out[f] = decryptSecret(v.slice(PREFIX.length)); } catch { out[f] = ""; }
    }
  }
  return out;
}

/** True when any credential field is still stored in plain text. */
export function hasPlainCredentials(stored: any): boolean {
  let config = stored;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { return false; }
  }
  if (!config || typeof config !== "object") return false;
  return ENCRYPTED_FIELDS.some((f) => typeof config[f] === "string" && config[f] !== "" && !config[f].startsWith(PREFIX));
}

/** A plain config as the admin page may see it: the password replaced by the placeholder. */
export function maskConfig<T extends Partial<Config> | null | undefined>(config: T): T {
  if (!config || typeof config !== "object") return config;
  const out: any = { ...config };
  if (typeof out.password === "string" && out.password !== "") out.password = PASSWORD_PLACEHOLDER;
  return out;
}

/** An incoming config from the admin page: the placeholder password means "keep `existing`". */
export function unmaskConfig(incoming: any, existing: Partial<Config> | null | undefined): any {
  if (!incoming || typeof incoming !== "object") return incoming;
  const out = { ...incoming };
  if (out.password === PASSWORD_PLACEHOLDER) {
    if (existing && typeof existing.password === "string") out.password = existing.password;
    else delete out.password;
  }
  return out;
}

/** A profile row as JSON for the admin page. */
export function maskProfile(profile: any): any {
  const p = typeof profile?.toJSON === "function" ? profile.toJSON() : { ...profile };
  p.config = maskConfig(p.config);
  return p;
}
