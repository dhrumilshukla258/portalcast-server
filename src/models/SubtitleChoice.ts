import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement } from "sequelize-typescript";

// An online subtitle a viewer kept on while watching a movie or an episode: the right file for
// it, in sync with this stream (owner 2026-11-04). One row per viewer, title and language
// (the latest choice wins). The search lists these first for everyone (content/subtitleChoices.ts);
// the file itself is in subtitle_files, so it loads even while its provider is down.
@Table({
  tableName: "subtitle_choices",
  timestamps: true,
  indexes: [{ unique: true, fields: ["profileId", "itemType", "itemId", "lang", "userId"] }],
})
export class SubtitleChoice extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare profileId: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare itemType: "movie" | "episode";

  /** The list item id the stream token names (movie stream id, episode id, "L…" for local files). */
  @Column({ type: DataType.STRING, allowNull: false })
  declare itemId: string;

  /** The language searched for ("en"). */
  @Column({ type: DataType.STRING, allowNull: false })
  declare lang: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  /** The download id ("os:<fileId>", "subdl:<path>", "gd:<id>", "jfsub:<id>"). */
  @Column({ type: DataType.STRING, allowNull: false })
  declare subtitleKey: string;

  /** Its release name, to list it when the provider's search no longer returns it. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare label: string | null;

  /** The timing the viewer settled on (+ later, − earlier). */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare delayMs: number;
}
