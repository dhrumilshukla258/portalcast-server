import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Index } from "sequelize-typescript";

export interface ProbeTrack {
  index: number;
  codec: string;
  language?: string | null;
  title?: string | null;
  channels?: number | null;
  default?: boolean;
  forced?: boolean;
}

export interface SidecarSubtitle {
  /** Path relative to the library folder. */
  relPath: string;
  language: string | null;
  forced: boolean;
  format: string;
}

/**
 * One video file of a local title (a version). Probed once with ffprobe and again only when
 * its size or modified time changes. Clients see it as `LF<id>`, never its path.
 */
@Table({ tableName: "media_files", timestamps: true })
export class MediaFile extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Index
  @Column(DataType.INTEGER)
  declare itemId: number;

  @Index
  @Column(DataType.INTEGER)
  declare libraryId: number;

  @Column(DataType.TEXT)
  declare root: string;

  /** Path relative to `root`. */
  @Index
  @Column(DataType.TEXT)
  declare relPath: string;

  @Column(DataType.BIGINT)
  declare size: number;

  @Column(DataType.FLOAT)
  declare mtimeMs: number;

  /** From the file name ("2160p", "Director's Cut") or the probed resolution. */
  @Column(DataType.STRING)
  declare versionLabel: string | null;

  @Column(DataType.STRING)
  declare container: string | null;

  @Column(DataType.FLOAT)
  declare duration: number | null;

  @Column(DataType.INTEGER)
  declare width: number | null;

  @Column(DataType.INTEGER)
  declare height: number | null;

  @Column(DataType.STRING)
  declare videoCodec: string | null;

  /** "HDR10", "HLG", "Dolby Vision" or null. */
  @Column(DataType.STRING)
  declare hdr: string | null;

  @Column(DataType.JSON)
  declare audioTracks: ProbeTrack[] | null;

  @Column(DataType.JSON)
  declare subtitleTracks: ProbeTrack[] | null;

  @Column(DataType.JSON)
  declare sidecars: SidecarSubtitle[] | null;

  @Column(DataType.DATE)
  declare probedAt: Date | null;

  @Column(DataType.TEXT)
  declare probeError: string | null;

  @Column(DataType.DATE)
  declare missingSince: Date | null;
}
