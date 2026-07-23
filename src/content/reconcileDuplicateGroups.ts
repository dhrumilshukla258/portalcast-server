import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";
import { UserProgress } from "@/models/UserProgress";
import { normalizeTitleKey } from "@/content/titleClean";
import { clearDiscoverCache } from "@/services/discoverCache";
import { logger } from "@/infra/logger";

// One-time reconciliation for duplicate ContentMeta rows created BEFORE two
// fixes this session:
//   1. normalizeTitleKey() didn't collapse a mid-title colon ("Title: Sub" vs
//      "Title Sub"), so the same real show could get two different groupKeys
//      depending on which punctuation variant the provider/TMDB used.
//   2. groupKey used the raw-provider-title-extracted year, not TMDB's own
//      resolved release year — a title whose raw text had no parseable year
//      got groupKey'd with an empty year even when TMDB matched successfully
//      and had a definitive one.
// Both fixes only apply going forward (new enrichment). This walks every
// existing row once, re-buckets by the FIXED normalized name (ignoring year
// for the initial bucketing — year is only used to decide whether rows
// within a name-bucket are safe to merge), and merges rows that are safe to
// merge: same year, or one side missing a year entirely. Rows with two
// different NON-EMPTY years (e.g. "Zorro" 1959 vs 2024 — genuinely different
// shows sharing a title) are deliberately left alone.
//
// Reuses the exact same "pick the best surviving row" tie-break as
// pruneContentMeta's sibling-promotion logic (metaEnrichment.ts): tmdb-sourced
// > has a poster > most recently enriched.
function score(row: any): number {
  return (row.source === "tmdb" ? 2 : 0) + (row.poster ? 1 : 0);
}

function pickBest(rows: any[]): any {
  return rows.reduce((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    if (sa !== sb) return sa > sb ? a : b;
    return new Date(a.enrichedAt) > new Date(b.enrichedAt) ? a : b;
  });
}

export async function reconcileDuplicateGroups(): Promise<void> {
  logger.info("[ReconcileGroups] Starting duplicate-group reconciliation...");

  const rows = (await ContentMeta.findAll({ raw: true })) as any[];
  logger.info(`[ReconcileGroups] Scanning ${rows.length} content_meta rows...`);

  const nameBuckets = new Map<string, any[]>();
  for (const row of rows) {
    const key = `${row.type}:${normalizeTitleKey(row.name)}`;
    const bucket = nameBuckets.get(key) || [];
    bucket.push(row);
    nameBuckets.set(key, bucket);
  }

  let groupsMerged = 0;
  let rowsDeleted = 0;
  let userProgressRepointed = 0;

  for (const [nameKey, bucketRows] of nameBuckets) {
    if (bucketRows.length < 2) continue;

    // Sub-group by year within this name bucket. Rows with an empty year
    // fold into whichever real-year subgroup exists in this bucket (there's
    // at most one distinct real year per genuinely-same-show case — if more
    // than one distinct non-empty year exists, treat each as its own
    // subgroup, i.e. don't merge across them).
    const distinctYears = new Set(bucketRows.map((r) => r.year || "").filter((y) => y));
    const yearSubgroups = new Map<string, any[]>();
    if (distinctYears.size <= 1) {
      // At most one real year in the whole bucket — safe to merge everything
      // (including empty-year rows) into a single subgroup.
      const soleYear = distinctYears.size === 1 ? [...distinctYears][0] : "";
      yearSubgroups.set(soleYear, bucketRows);
    } else {
      // More than one distinct real year — only merge rows that share the
      // exact same real year; leave empty-year rows out of any merge here
      // (ambiguous which real year they'd belong to) and leave genuinely
      // different years (e.g. two different remakes) untouched.
      for (const row of bucketRows) {
        if (!row.year) continue;
        const bucket = yearSubgroups.get(row.year) || [];
        bucket.push(row);
        yearSubgroups.set(row.year, bucket);
      }
    }

    for (const [, group] of yearSubgroups) {
      if (group.length < 2) continue;

      const winner = pickBest(group);
      const losers = group.filter((r) => r.id !== winner.id);
      const resolvedYear = winner.year || group.find((r) => r.year)?.year || "";
      const newGroupKey = `${winner.type}:${normalizeTitleKey(winner.name)}:${resolvedYear}`;

      logger.info(
        `[ReconcileGroups] Merging ${group.length} rows for "${winner.name}" (${resolvedYear || "no year"}) — keeping ${winner.id}, removing ${losers.map((l) => l.id).join(", ")}`
      );

      for (const loser of losers) {
        await ContentGenre.destroy({ where: { contentId: loser.id } });
        await ContentCountry.destroy({ where: { contentId: loser.id } });
        await ContentTheme.destroy({ where: { contentId: loser.id } });
        await ContentMeta.destroy({ where: { id: loser.id } });
        rowsDeleted++;

        // UserProgress.mediaId is keyed by playback-file id, not ContentMeta
        // id directly, so there's no row to migrate here in general — but if
        // any progress row's mediaId happens to equal the loser's id (can
        // happen for movies, where mediaId sometimes IS the catalog id),
        // repoint it to the surviving row so Continue Watching doesn't break.
        const repointed = await UserProgress.update(
          { mediaId: winner.id },
          { where: { mediaId: loser.id } }
        );
        userProgressRepointed += repointed[0] || 0;
      }

      await ContentMeta.update(
        { groupKey: newGroupKey, year: resolvedYear || null, isRepresentative: true },
        { where: { id: winner.id } }
      );
      for (const Model of [ContentGenre, ContentCountry, ContentTheme]) {
        await Model.update({ isRepresentative: true }, { where: { contentId: winner.id } });
      }

      groupsMerged++;
    }
  }

  clearDiscoverCache();
  logger.info(
    `[ReconcileGroups] Done. ${groupsMerged} duplicate group(s) merged, ${rowsDeleted} row(s) removed, ${userProgressRepointed} UserProgress row(s) repointed.`
  );
}

if (require.main === module) {
  (async () => {
    try {
      const { initDB } = await import("../db");
      await initDB();
      await reconcileDuplicateGroups();
      process.exit(0);
    } catch (error) {
      console.error("Reconciliation script failed:", error);
      process.exit(1);
    }
  })();
}
