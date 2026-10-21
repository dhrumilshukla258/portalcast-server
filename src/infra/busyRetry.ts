import { logger } from "@/infra/logger";

/**
 * Retries a write that met "database is locked": the metadata backfills and a library scan
 * write at the same time, and SQLite has one writer, so a write can find the lock taken for
 * longer than the 5 s busy wait. A few spaced retries get through.
 */
export async function withBusyRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(e?.message ?? e));
      if (!busy || attempt >= 6) throw e;
      logger.warn(`${what}: database busy, retrying (${attempt})`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}
