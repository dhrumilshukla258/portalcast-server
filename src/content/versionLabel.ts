// The short label a version picker shows for one copy of a title ("Hindi 1080p",
// "Tamil (+ English Subtitles)", "Local · Malayalam, English 4K"), never the whole raw
// catalog name when there is any signal to offer. Used by Discover's variants route and by
// search results (`version_label`), so both apps label versions the same way.

import { extractLanguageInfo, extractQualityTags, extractLanguageFromCategoryName } from "@/content/titleClean";
import { readGenres } from "@/infra/storage";
import { localVersionLabel } from "@/content/library/catalog";

export interface CategoryNames {
  movie: Map<string, string>;
  series: Map<string, string>;
}

export async function categoryNames(profileId?: number | null): Promise<CategoryNames> {
  const [movies, series] = await Promise.all([readGenres("movie", profileId ?? undefined), readGenres("series", profileId ?? undefined)]);
  return {
    movie: new Map(movies.map((g: any) => [String(g.id), g.title as string])),
    series: new Map(series.map((g: any) => [String(g.id), g.title as string])),
  };
}

/**
 * An IPTV copy's label. The category name (e.g. "Hindi | Dubbed") is the ground truth for
 * the AUDIO and wins over the title's own tags, which this portal contradicts ("Eng Dub"
 * means Hindi audio here, see LANGUAGE_ALIASES); the title is the fallback and the only
 * source for "Sub" (subtitled, not dubbed). A measured resolution beats quality words.
 */
export function iptvVersionLabel(name: string, categoryName: string | undefined, measuredLabel?: string): string {
  const categoryAudio = categoryName ? extractLanguageFromCategoryName(categoryName) : null;
  const { audio: titleAudio, subtitles } = extractLanguageInfo(name);
  const audio = categoryAudio || titleAudio;
  let languagePart: string | null = null;
  if (audio && subtitles && audio !== subtitles) languagePart = `${audio} (+ ${subtitles} Subtitles)`;
  else if (audio) languagePart = audio;
  else if (subtitles) languagePart = `Original Audio (${subtitles} Subtitles)`;
  const qualityTags = measuredLabel ? [measuredLabel] : extractQualityTags(name);
  const qualitySuffix = qualityTags.length > 0 ? ` ${qualityTags.join(" ")}` : "";
  return languagePart ? `${languagePart}${qualitySuffix}` : qualityTags.length > 0 ? qualityTags.join(" ") : name;
}

/** Adds `version_label` to search result items (IPTV list items and local "L<id>" items). */
export async function withVersionLabels<T extends Record<string, any>>(items: T[], type: "movie" | "series", profileId?: number | null): Promise<T[]> {
  if (!items.length) return items;
  const names = await categoryNames(profileId);
  const out: T[] = [];
  for (const it of items) {
    const id = String(it.stream_id ?? it.series_id ?? it.id ?? "");
    const local = String(it.is_local) === "1" || /^L\d+$/.test(id);
    const label = local
      ? (await localVersionLabel(`${type}_${id}`)) ?? "Local"
      : iptvVersionLabel(String(it.name ?? it.title ?? ""), names[type].get(String(it.category_id)), it.video?.label);
    out.push({ ...it, version_label: label });
  }
  return out;
}
