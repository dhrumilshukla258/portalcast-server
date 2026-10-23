import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Index,
  Default,
  HasMany,
} from "sequelize-typescript";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";

export type ContentType = "movie" | "series";
export type ContentMetaSource = "tmdb" | "provider" | "none";

@Table({ tableName: "content_meta", timestamps: true })
export class ContentMeta extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare id: string; // "movie_{stream_id}" or "series_{series_id}"

  @Index
  @Column(DataType.STRING)
  declare type: ContentType;

  @Column(DataType.STRING)
  declare name: string;

  @Column(DataType.STRING)
  declare poster: string;

  // Best backdrop TMDB has for this title, any resolution — used for the
  // detail-page hero (MediaInfoHeader), where showing *something* beats
  // showing nothing. Distinct from `poster`, which is the card's own
  // portrait image.
  @Column(DataType.STRING)
  declare backdrop: string;

  // Same pool as `backdrop`, but only set when it also clears
  // MIN_BACKDROP_WIDTH (tmdb.ts) — used for the ambient rotation
  // (AmbientBackdrop), which skips a title entirely rather than show a
  // soft/upscaled-looking backdrop for it.
  @Column(DataType.STRING)
  declare backdropHd: string;

  // Set the moment backfillBackdrops() (metaEnrichment.ts) has attempted this
  // row, regardless of outcome — a null `backdropHd` alone can't distinguish
  // "never checked" from "checked, TMDB genuinely has no HD backdrop for
  // this title," which used to make every backfill run re-fetch the same
  // permanently-backdrop-less rows from TMDB forever. Filtering on this
  // column instead means each row only ever gets fetched once.
  @Column(DataType.DATE)
  declare backdropCheckedAt: Date;

  @Column(DataType.STRING)
  declare year: string;

  @Index
  @Column(DataType.STRING)
  declare originalLanguage: string; // ISO 639-1 code from TMDB, e.g. "hi", "en"

  @Column(DataType.INTEGER)
  declare tmdbId: number;

  @Default("none")
  @Column(DataType.STRING)
  declare source: ContentMetaSource; // where genre/country/language came from

  // PERF INCIDENT (2026-07-17): no index existed here despite every Discover
  // browse/genre-row query ORDER BY-ing on it — fine for a plain single-table
  // scan (~400ms, tolerable), but combined with a genre/country/theme JOIN,
  // SQLite couldn't use an index to short-circuit straight to the top 40 rows
  // and instead had to materialize/sort a much larger joined result set,
  // which never completed in testing (multiple concurrent genre-row requests
  // hung indefinitely). Confirmed via real timing logs before/after this fix.
  @Column(DataType.DATE)
  declare enrichedAt: Date;

  // Normalized base title (normalizeTitleKey(name) — strips channel prefixes,
  // language/dub/quality tags) shared by every language/format variant of the
  // "same" title (e.g. "ABC Tamil", "ABC South Dub", "ABC Telugu" all share
  // one groupKey). Lets Discover show one card per real title instead of one
  // per raw catalog entry, with a separate endpoint listing all variants
  // sharing a groupKey for the "which language?" picker on click.
  @Column(DataType.STRING)
  declare groupKey: string;

  // Cleaned display title (stripReleaseNoise(name) — same stripping as
  // groupKey, but case-preserved, not lowercased) — "ABC - Hindi Dub" shows
  // to users as "ABC" instead of the raw, tag-cluttered catalog name.
  // Precomputed once (enrichment time / migration backfill), same reasoning
  // as groupKey: never recomputed per-request.
  @Column(DataType.STRING)
  declare trimmedName: string;

  // The category this row was actually enriched from (the loop variable in
  // enrichMovies/enrichSeries at the moment upsertContent() was called for
  // this id) — the one moment we know it with certainty. Re-deriving it later
  // by scanning cached per-category lists for a matching stream_id/series_id
  // is unreliable: some portals reuse numeric ids across categories for
  // unrelated titles, or a category's cache can be stale, so "first list that
  // contains this id" isn't necessarily the id's real/current category.
  // Nullable for rows enriched before this column existed.
  @Column(DataType.STRING)
  declare portalCategoryId: string;

  // Comma-joined cast names / director name from TMDB credits (tmdb.ts's
  // extractCredits) — same comma-separated shape the portal catalog's own
  // actors field already uses, so MediaInfoHeader's .split(',') needs no
  // changes to render either source.
  @Column(DataType.STRING)
  declare cast: string;

  @Column(DataType.STRING)
  declare director: string;

  // Description: TMDB's overview, else the portal's own plot. Discover sends it with every
  // card (the hero and detail show it without another lookup).
  @Column(DataType.TEXT)
  declare overview: string;

  // User score 0-10: TMDB's vote average (ratingCount = its votes), else TVmaze's average
  // (ratingCount null). Discover sends it as rating_tmdb when it rests on enough votes.
  @Column(DataType.FLOAT)
  declare rating: number;

  @Column(DataType.INTEGER)
  declare ratingCount: number;

  // IMDb id from TMDB; IMDb rating and votes from IMDb's daily ratings file (imdbRatings.ts).
  @Column(DataType.STRING)
  declare imdbId: string;

  @Column(DataType.FLOAT)
  declare imdbRating: number;

  @Column(DataType.INTEGER)
  declare imdbVotes: number;

  // Detail-page data, as detailed as Jellyfin's NFO files (TMDB, or a local title's NFO).
  // Cast and crew with photos live in content_people.
  @Column(DataType.TEXT)
  declare tagline: string | null;

  /** Age rating: "PG-13", "TV-14", "U/A 13+". */
  @Column(DataType.STRING)
  declare ageRating: string | null;

  /** Minutes (a series: its usual episode length). */
  @Column(DataType.INTEGER)
  declare runtime: number | null;

  /** Studios (movie) or networks (series), comma-separated. */
  @Column(DataType.TEXT)
  declare studios: string | null;

  @Column(DataType.STRING)
  declare collection: string | null;

  @Column(DataType.STRING)
  declare originalTitle: string | null;

  /** YYYY-MM-DD. */
  @Column(DataType.STRING)
  declare premiered: string | null;

  /** Transparent title logo (URL, or a local-art marker). */
  @Column(DataType.STRING)
  declare logo: string | null;

  /** Writers, comma-separated. */
  @Column(DataType.TEXT)
  declare writers: string | null;

  /** YouTube key of the title's trailer (from TMDB), shown on detail pages. */
  @Column(DataType.STRING)
  declare trailerKey: string | null;

  /** Custom artwork chosen in the admin page, per kind (content/customArt.ts): locked against refreshes. */
  @Column(DataType.JSON)
  declare artLocked: any | null;

  /** The TMDB id an admin chose with "Fix match" (content/metaEnrichment.ts fixPortalMatch): no job matches the title again. */
  @Column(DataType.INTEGER)
  declare tmdbIdLocked: number | null;

  /** When the details backfill got TMDB's answer (even an empty one). */
  @Column(DataType.DATE)
  declare detailsCheckedAt: Date | null;

  // When the ratings backfill got TMDB's answer for this title (even one without a rating
  // or IMDb id), so a restart does not ask again.
  @Column(DataType.DATE)
  declare ratingsCheckedAt: Date;

  // From OMDb by IMDb id (omdb.ts), when OMDB_API_KEY is set: "94%" and 0-100.
  @Column(DataType.STRING)
  declare rtRating: string;

  @Column(DataType.INTEGER)
  declare metascore: number;

  @Column(DataType.DATE)
  declare omdbCheckedAt: Date;

  // Exactly one row per groupKey is flagged true (recomputed by
  // recomputeRepresentatives() in metaEnrichment.ts) — the "best" variant
  // (prefers TMDB-sourced, then most complete data) shown as the single card
  // in listings. Filtering on this plain boolean instead of a live GROUP BY
  // avoids SQLite's undefined-row-per-group behavior for non-aggregated
  // GROUP BY queries.
  @Column(DataType.BOOLEAN)
  declare isRepresentative: boolean;

  @HasMany(() => ContentGenre, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentGenres: ContentGenre[];

  @HasMany(() => ContentCountry, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentCountries: ContentCountry[];

  @HasMany(() => ContentTheme, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentThemes: ContentTheme[];
}
