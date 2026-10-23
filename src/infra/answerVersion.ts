// Answer versions (plan, Phase 3a): a version that changes whenever any input of a catalog
// answer may have changed. The apps repeat it as `v=` on catalog requests, and an answer to the
// current version is cached for a year (infra/httpCaching.ts): a screen visited again is drawn
// from the device's HTTP cache with no request at all. When the version moves the addresses
// change, so only screens opened again are fetched, once each.
//
// The version covers:
//   - this server's start (a random id): new code never serves an answer cached by old code
//   - the catalog change log (content/catalog/changes.ts): every database write to titles,
//     tags, people, credits, overrides, genres and IPTV lists. That log exists only while the
//     in-memory catalog is on, so with it off there is no version and the apps cache as before.
//   - overrides, Discover cache clears (enrichment, local library scans, edits), video quality
//     reports and setting changes: counted here
//   - the active IPTV profile
// Personal answers (Home) add what that viewer's Home depends on (X-Home-Version, content/home.ts
// homeVersionOf): their own history, what anyone has watched, the day, trending and charts.
// Watch progress changes every 30 s during playback and must not move the catalog version, nor
// other viewers' Home version.
//
// The change log is read by the catalog store's 5 s poll (and on every catalogChanges call):
// an answer cached in those seconds after a write is stale only until the app sees the next
// version, which comes with any response it gets (progress saves, status polls).

import crypto from "crypto";
import { setting } from "@/config/settings";
import { overridesGeneration } from "@/content/overrides";
import { catalogSnapshot, knownCatalogChange } from "@/content/catalog/store";
import { viewerGeneration } from "@/content/viewers";
import { homeVersionOf } from "@/content/home";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";

const BOOT = crypto.randomBytes(4).toString("hex");
let inputs = 0;

/** Something an answer depends on changed outside the change log (see the header). */
export function bumpAnswerInputs(): void {
  inputs++;
}

/** The current catalog answer version, or null when there is none (in-memory catalog off). */
export async function catalogAnswerVersion(): Promise<string | null> {
  if (!setting<boolean>("catalogSnapshot") || !catalogSnapshot()) return null;
  const seq = knownCatalogChange();
  if (seq === null) return null;
  return `${BOOT}.${seq}.${overridesGeneration()}.${inputs}.${(await getActiveProfileId()) ?? 0}`;
}

/**
 * The version of personal answers (Home): the catalog version plus everything this viewer's
 * Home depends on. Without a signed-in viewer (or an active profile), every viewer's progress,
 * as before.
 */
export async function homeAnswerVersion(catalogVersion: string, userId?: number): Promise<string> {
  const profileId = userId === undefined ? undefined : await getActiveProfileId();
  if (userId === undefined || profileId === undefined) return `${catalogVersion}.${viewerGeneration()}`;
  return `${catalogVersion}.${homeVersionOf(userId, profileId)}`;
}
