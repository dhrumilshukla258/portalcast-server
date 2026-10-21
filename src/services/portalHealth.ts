// Is the IPTV portal reachable? Checked every minute with one small request to the portal's
// address: any HTTP answer (even an error page) means online; a timeout or a network error
// means offline. The apps ask GET /api/v2/health/iptv and grey out IPTV while it is offline;
// the local library keeps playing (docs/skill-local-library.md, "Offline").
//
// Its own timer, not the job runner: a long backup or scan must not delay this.

import axios from "axios";
import { initialConfig } from "@/config/server";
import { logger } from "@/infra/logger";

const EVERY_MS = 60_000;
const TIMEOUT_MS = 6_000;
/** Two failures in a row before calling it offline: one slow answer is not an outage. */
const FAILS_TO_OFFLINE = 2;

let online = true;
let since = Date.now();
let lastCheck = 0;
let fails = 0;
let timer: NodeJS.Timeout | null = null;

function portalBase(): string | null {
  const host = String((initialConfig as any).hostname || "").trim();
  if (!host || host === "portal.example.com") return null;
  if (/^https?:\/\//i.test(host)) return host;
  const https = Boolean((initialConfig as any).https);
  const port = Number((initialConfig as any).port) || (https ? 443 : 80);
  const defaultPort = https ? 443 : 80;
  return `${https ? "https" : "http"}://${host}${port === defaultPort ? "" : `:${port}`}/`;
}

async function check(): Promise<void> {
  const base = portalBase();
  lastCheck = Date.now();
  if (!base) return; // no portal configured: nothing to report
  let ok = false;
  try {
    await axios.get(base, { timeout: TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, responseType: "stream" }).then((r) => r.data?.destroy?.());
    ok = true;
  } catch {
    ok = false;
  }
  if (ok) {
    fails = 0;
    if (!online) {
      online = true;
      since = Date.now();
      logger.info("[health] IPTV portal reachable again");
    }
  } else if (++fails >= FAILS_TO_OFFLINE && online) {
    online = false;
    since = Date.now();
    logger.warn("[health] IPTV portal unreachable: apps show IPTV as offline; the local library keeps playing");
  }
}

export function startPortalHealth(): void {
  if (timer) return;
  void check();
  timer = setInterval(() => void check(), EVERY_MS);
  timer.unref?.();
}

export function iptvHealth() {
  return { iptv: online ? "online" : "offline", since: new Date(since).toISOString(), checkedAt: lastCheck ? new Date(lastCheck).toISOString() : null };
}
