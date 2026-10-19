import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

// A subtitle already fetched from a provider, stored as WebVTT so every later request for
// the same file is served locally. Providers cap free downloads per day (OpenSubtitles
// ~5 without a user login, SubDL ~50 per key); this spends each file's download once.
// key: "os:<fileId>" | "subdl:<path>".
@Table({ tableName: "subtitle_files", timestamps: true })
export class SubtitleFile extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare key: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare vtt: string;
}
