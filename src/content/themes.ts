// Curated "theme" buckets for the Discover browse UI. TMDB has no first-class theme
// field — these are hand-picked TMDB keyword IDs (stable, looked up once via
// https://www.themoviedb.org/keyword/{id}) grouped into buckets a viewer would
// actually browse by, rather than exposing TMDB's raw (huge, noisy) keyword list.
export const THEME_KEYWORDS: Record<string, number[]> = {
  "Heist":          [10051, 173772],
  "Underdog":       [9717, 179352],
  "True Story":     [9672],
  "Feel-Good":      [158718, 9840],
  "Revenge":        [9748],
  "Coming-of-Age":  [179431, 10683],
  "Time Travel":    [4565],
  "Survival":       [10091],
};

const KEYWORD_TO_THEMES = new Map<number, string[]>();
for (const [theme, ids] of Object.entries(THEME_KEYWORDS)) {
  for (const id of ids) {
    const list = KEYWORD_TO_THEMES.get(id) ?? [];
    list.push(theme);
    KEYWORD_TO_THEMES.set(id, list);
  }
}

export function themesForKeywordIds(keywordIds: number[]): string[] {
  const themes = new Set<string>();
  for (const id of keywordIds) {
    for (const theme of KEYWORD_TO_THEMES.get(id) ?? []) themes.add(theme);
  }
  return [...themes];
}
