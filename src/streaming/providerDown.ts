// "The provider is not answering" (plan Phase 5): when the IPTV provider is down, a play
// request answers at once with a clear message instead of a spinner and a generic error.
// Before calling: the portal health check already says offline (two failed probes,
// services/portalHealth.ts). After: the call failed because the provider could not be reached
// (circuit breaker open, timeout, refused or reset connection). Both answer 503 with
// `code: "provider_unavailable"`; the apps show `error`. The local library is never affected.

import { iptvHealth } from "@/services/portalHealth";

export const PROVIDER_DOWN_MESSAGE = "The IPTV provider is not answering right now. Try again in a minute.";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_SOCKET_CONNECTION_TIMEOUT"]);

/** The error says the provider could not be reached (not a missing title or a bad request). */
export function isProviderDown(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  const message = String(e.message ?? e);
  if (message.includes("circuit breaker is open")) return true;
  if (NETWORK_CODES.has(String(e.code ?? e.cause?.code ?? ""))) return true;
  return /timeout of \d+ms exceeded|socket hang up/i.test(message);
}

/** The portal health check says offline: do not even ask. */
export function providerKnownDown(): boolean {
  return iptvHealth().iptv === "offline";
}

export function providerDownBody() {
  return { success: false, error: PROVIDER_DOWN_MESSAGE, code: "provider_unavailable" };
}
