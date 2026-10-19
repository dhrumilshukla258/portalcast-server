import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

// A subtitle file already fetched from OpenSubtitles, stored as WebVTT so every later
// request for the same file is served locally. Their API allows only a handful of
// downloads per day without a user login; this spends each file's download once, ever.
@Table({ tableName: "subtitle_files", timestamps: true })
export class SubtitleFile extends Model {
  @PrimaryKey
  @Column(DataType.INTEGER)
  declare fileId: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare vtt: string;
}
