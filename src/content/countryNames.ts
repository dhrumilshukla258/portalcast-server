// TMDB's TV/series responses give origin_country as raw ISO 3166-1 alpha-2
// codes (e.g. "IN", "US") with no name attached, unlike movies'
// production_countries, which already include the full name — without
// resolving these, the same country shows up as two different facet values
// depending on whether it was tagged via a movie or a series (e.g. "India"
// and "IN"). Only ever hand-maintaining a lookup table for this (the
// original approach here) is a losing game — the catalog kept turning up
// codes the table didn't cover (IO, NG, LV, KW, JO, GE, AZ, AM, HR, ...),
// each one a fresh silent gap, same failure mode already hit once for
// ISO_LANGUAGE_NAMES in titleClean.ts. Intl.DisplayNames (Node 18+, this
// project targets Node 20) resolves any real ISO 3166-1 code generically —
// same fix the webui already applies for language codes (languageName() in
// DiscoverFilters.tsx via Intl.DisplayNames type:'language').
let regionDisplayNames: Intl.DisplayNames | undefined;
try {
  regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  // Environments without Intl.DisplayNames support fall through to the
  // overrides/raw-code fallback below.
}

// A handful of non-standard/historical codes TMDB still emits that aren't
// real current ISO 3166-1 alpha-2 codes, so Intl.DisplayNames can't resolve
// them either — "SU" (Soviet Union) and "XC"/"XI" (TMDB's own placeholder
// codes for Czechoslovakia/Kosovo) are user-assigned, not CLDR-registered.
const COUNTRY_NAME_OVERRIDES: Record<string, string> = {
  SU: "Soviet Union",
  XC: "Czechoslovakia",
  XI: "Kosovo",
};

export function countryLabel(code: string): string {
  const upper = code.toUpperCase();
  if (COUNTRY_NAME_OVERRIDES[upper]) return COUNTRY_NAME_OVERRIDES[upper];
  try {
    const name = regionDisplayNames?.of(upper);
    if (name && name.toUpperCase() !== upper) return name;
  } catch {
    // Intl.DisplayNames throws on a string it doesn't recognize as a valid
    // region code at all (e.g. a 3-letter code) — fall through to raw code.
  }
  return code;
}
