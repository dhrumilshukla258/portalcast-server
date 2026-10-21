import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Index } from "sequelize-typescript";

/**
 * Cast and crew of a title (IPTV or local): who, as what, in which order, with a photo.
 * Filled from TMDB credits, or from a local title's NFO file. One row per credit.
 */
@Table({ tableName: "content_people", timestamps: false })
export class ContentPerson extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  /** content_meta id ("movie_123", "series_L4"). */
  @Index
  @Column(DataType.STRING)
  declare contentId: string;

  /** "cast", "director", "writer" or "creator". */
  @Column(DataType.STRING)
  declare kind: string;

  @Column(DataType.STRING)
  declare name: string;

  /** The character played (cast) or the job ("Screenplay"). */
  @Column(DataType.STRING)
  declare role: string | null;

  @Column(DataType.INTEGER)
  declare sortOrder: number;

  /** TMDB person id, when known. */
  @Column(DataType.INTEGER)
  declare tmdbPersonId: number | null;

  /** Photo URL (TMDB 185 px profile), when known. */
  @Column(DataType.STRING)
  declare photo: string | null;
}
