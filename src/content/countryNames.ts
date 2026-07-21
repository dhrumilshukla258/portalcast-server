// TMDB's TV/series responses give origin_country as raw ISO 3166-1 alpha-2
// codes (e.g. "IN", "US") with no name attached, unlike movies'
// production_countries, which already include the full name — without this
// map, the same country shows up as two different facet values depending on
// whether it was tagged via a movie or a series (e.g. "India" and "IN").
export const COUNTRY_NAMES: Record<string, string> = {
  US: "United States of America", GB: "United Kingdom", IN: "India", CA: "Canada",
  AU: "Australia", FR: "France", DE: "Germany", IT: "Italy", ES: "Spain",
  JP: "Japan", KR: "South Korea", CN: "China", HK: "Hong Kong", TW: "Taiwan",
  RU: "Russia", BR: "Brazil", MX: "Mexico", AR: "Argentina", NL: "Netherlands",
  SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", PL: "Poland",
  TR: "Turkey", TH: "Thailand", ID: "Indonesia", MY: "Malaysia", PH: "Philippines",
  VN: "Vietnam", SG: "Singapore", PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka",
  NP: "Nepal", IE: "Ireland", NZ: "New Zealand", ZA: "South Africa", EG: "Egypt",
  SA: "Saudi Arabia", AE: "United Arab Emirates", IL: "Israel", IR: "Iran",
  PT: "Portugal", BE: "Belgium", CH: "Switzerland", AT: "Austria", GR: "Greece",
  CZ: "Czech Republic", HU: "Hungary", RO: "Romania", UA: "Ukraine", CO: "Colombia",
  CL: "Chile", PE: "Peru",
};

export function countryLabel(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] || code;
}
