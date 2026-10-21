import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Index } from "sequelize-typescript";

/**
 * One title in a local library (a movie folder, or a lone file): its catalog row is
 * `content_meta` id `movie_L<id>`, listed under the "local" category. Its files (versions)
 * are MediaFile rows. See docs/skill-local-library.md.
 */
@Table({ tableName: "local_items", timestamps: true })
export class LocalItem extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Index
  @Column(DataType.INTEGER)
  declare libraryId: number;

  /** "movie" or "series". */
  @Column(DataType.STRING)
  declare kind: string;

  /** Library folder this title was found under, and its path relative to that folder. */
  @Column(DataType.TEXT)
  declare root: string;

  /** Title folder relative to `root` (a lone file: its own relative path). Unique per root. */
  @Index
  @Column(DataType.TEXT)
  declare relPath: string;

  /** Name and year as parsed from the folder/file name or NFO. */
  @Column(DataType.STRING)
  declare name: string;

  @Column(DataType.STRING)
  declare year: string | null;

  /** TMDB id from the folder name or an NFO file. */
  @Column(DataType.INTEGER)
  declare tmdbIdHint: number | null;

  /** TMDB id chosen with "Fix match": wins over everything, never changed by a scan. */
  @Column(DataType.INTEGER)
  declare tmdbIdLocked: number | null;

  /** TMDB id the last match produced (null = unmatched). */
  @Column(DataType.INTEGER)
  declare matchedTmdbId: number | null;

  @Column(DataType.DATE)
  declare matchedAt: Date | null;

  /** Artwork found in the title folder (content/library/art.ts): file names and a version. */
  @Column(DataType.JSON)
  declare art: { poster?: string; backdrop?: string; logo?: string; v?: number } | null;

  /** The title's NFO file, parsed (content/library/nfo.ts), when it has one. */
  @Column(DataType.JSON)
  declare nfo: any | null;

  /** Set when none of its files are on disk any more; removed after 7 days. */
  @Column(DataType.DATE)
  declare missingSince: Date | null;
}
