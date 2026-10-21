// Is the IPTV portal reachable? Real traffic answers that first: any portal answer in the
// last 5 minutes (services/outboundTraffic.ts sees every request) means online, with no extra
// request. Only when the portal has been quiet for 5 minutes is it probed with one small
// request; a network failure seen in real traffic is confirmed by a probe at once, and while
// it is offline it is probed every minute until it answers. Any HTTP answer (even an error
// page) means online; a timeout or a network error means offline. Before: a probe every
// minute (1,440 a day). The apps learn the result from a header on every answer (server.ts)
// and from GET /api/v2/health/iptv; the local library keeps playing (skill-local-library.md).
//
// Its own timer, not the job runner: a long backup or scan must not delay this.

import { portalContact } from "@/services/outboundTraffic";
import axios from "axios";
import { initialConfig } from "@/config/server";
import { logger } from "@/infra/logger";

const EVERY_MS = 60_000;
/** Without real traffic for this long, one probe confirms the portal is still there. */
const QUIET_PROBE_MS = 5 * 60_000;
let lastProbe = 0;
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
  if (!base) return; // no portal configured: nothing to report
  const now = Date.now();
  const { lastAnswer, lastFailure } = portalContact();
  // Real traffic answered recently, with no failure since: online, no request needed.
  if (online && lastAnswer > 0 && now - lastAnswer < QUIET_PROBE_MS && lastAnswer >= lastFailure) {
    lastCheck = lastAnswer;
    fails = 0;
    return;
  }
  // Probed recently and nothing has failed since: wait for the quiet period to pass.
  if (online && now - lastProbe < QUIET_PROBE_MS && lastFailure <= lastProbe) return;
  lastProbe = now;
  lastCheck = now;
  let ok = false;
  try {
    await axios
      .get(base, { timeout: TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, responseType: "stream", countAs: "portal health" } as any)
      .then((r) => r.data?.destroy?.());
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
