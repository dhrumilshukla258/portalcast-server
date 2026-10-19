import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement } from "sequelize-typescript";

// Measured video properties of a title, reported by the clients once playback starts
// (the player knows the real decoded size/frame rate). Portal names are unreliable
// ("Ek Din HDCam" can be a clean 1080p file), so this is what quality badges show.
// See content/mediaInfo.ts.
@Table({
  tableName: "media_info",
  timestamps: true,
  indexes: [{ unique: true, fields: ["profileId", "itemType", "itemId"] }],
})
export class MediaInfo extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare profileId: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare itemType: "movie" | "episode";

  /** Raw catalog id (movie stream_id / episode id), no "movie_" prefix. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare itemId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare width: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare height: number;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare fps: number | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare codec: string | null;
}
