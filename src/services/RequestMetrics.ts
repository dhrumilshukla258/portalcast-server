// Tracks outbound request volume to the Stalker/Xtream portal, separate from
// StreamTracker (which tracks active viewer sessions). This answers "how hard are
// we hitting the portal" rather than "who is watching what right now" — useful for
// diagnosing portal-side rate limiting (e.g. 429s) or gauging load before it happens.
//
// In-memory only, same tradeoff as StreamTracker: doesn't need to survive a restart,
// and a bounded ring buffer means this can never grow without limit.
import { socketService } from "@/services/SocketService";

export type PortalRequestCategory = "live" | "movie" | "series" | "epg" | "auth" | "other";
export type PortalRequestOutcome = "success" | "error";

interface Bucket {
  bucketStart: number; // ms epoch, floored to BUCKET_MS
  count: number;
  errorCount: number;
}

const BUCKET_MS = 60_000; // 1-minute buckets
const HISTORY_MS = 6 * 60 * 60 * 1000; // keep 6 hours of buckets
const MAX_BUCKETS = HISTORY_MS / BUCKET_MS;
const MAX_RECENT = 200; // bounded ring buffer, so a page load has something to show before the live feed catches up

export interface PortalRequestEvent {
  timestamp: string;
  category: PortalRequestCategory;
  outcome: PortalRequestOutcome;
  statusCode?: number;
}

class RequestMetrics {
  private buckets: Bucket[] = [];
  private recent: PortalRequestEvent[] = [];
  private totalRequests = 0;
  private totalErrors = 0;
  private byCategory: Record<PortalRequestCategory, number> = {
    live: 0,
    movie: 0,
    series: 0,
    epg: 0,
    auth: 0,
    other: 0,
  };
  private readonly since = new Date();

  record(category: PortalRequestCategory, outcome: PortalRequestOutcome, statusCode?: number): void {
    this.totalRequests++;
    this.byCategory[category] = (this.byCategory[category] ?? 0) + 1;
    if (outcome === "error") this.totalErrors++;

    const bucketStart = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    let last = this.buckets[this.buckets.length - 1];
    if (!last || last.bucketStart !== bucketStart) {
      last = { bucketStart, count: 0, errorCount: 0 };
      this.buckets.push(last);
      if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
    }
    last.count++;
    if (outcome === "error") last.errorCount++;

    const event: PortalRequestEvent = { timestamp: new Date().toISOString(), category, outcome, statusCode };
    this.recent.push(event);
    if (this.recent.length > MAX_RECENT) this.recent.shift();

    // Broadcasting is a no-op if no admin has the live view open (socket.io skips
    // the emit when the room is empty) — cheap enough to call unconditionally
    // rather than tracking listener counts ourselves.
    socketService.broadcastPortalRequest(event);
  }

  recentEvents(): PortalRequestEvent[] {
    return this.recent;
  }

  snapshot() {
    const cutoff = Date.now() - HISTORY_MS;
    const timeline = this.buckets
      .filter((b) => b.bucketStart >= cutoff)
      .map((b) => ({
        bucket: new Date(b.bucketStart).toISOString(),
        count: b.count,
        errorCount: b.errorCount,
      }));

    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      since: this.since.toISOString(),
      byCategory: { ...this.byCategory },
      timeline,
      // Seeds the live view on initial page load — the socket "portal_request"
      // event stream (room "portal-metrics") takes over for anything after that.
      recent: this.recent,
    };
  }
}

export const requestMetrics = new RequestMetrics();
