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
  @Index
  @Column(DataType.DATE)
  declare enrichedAt: Date;

  // Normalized base title (normalizeTitleKey(name) — strips channel prefixes,
  // language/dub/quality tags) shared by every language/format variant of the
  // "same" title (e.g. "ABC Tamil", "ABC South Dub", "ABC Telugu" all share
  // one groupKey). Lets Discover show one card per real title instead of one
  // per raw catalog entry, with a separate endpoint listing all variants
  // sharing a groupKey for the "which language?" picker on click.
  @Index
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

  // Exactly one row per groupKey is flagged true (recomputed by
  // recomputeRepresentatives() in metaEnrichment.ts) — the "best" variant
  // (prefers TMDB-sourced, then most complete data) shown as the single card
  // in listings. Filtering on this plain boolean instead of a live GROUP BY
  // avoids SQLite's undefined-row-per-group behavior for non-aggregated
  // GROUP BY queries.
  @Index
  @Column(DataType.BOOLEAN)
  declare isRepresentative: boolean;

  @HasMany(() => ContentGenre, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentGenres: ContentGenre[];

  @HasMany(() => ContentCountry, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentCountries: ContentCountry[];

  @HasMany(() => ContentTheme, { foreignKey: "contentId", sourceKey: "id" })
  declare ContentThemes: ContentTheme[];
}
