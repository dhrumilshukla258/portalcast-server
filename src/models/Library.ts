import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Default } from "sequelize-typescript";

/**
 * A local library (Admin › Libraries): folders on the NAS, mounted into the container,
 * scanned for movies (series come in phase 2). See docs/skill-local-library.md.
 */
@Table({ tableName: "libraries", timestamps: true })
export class Library extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column(DataType.STRING)
  declare name: string;

  /** "movies" or "series". */
  @Column(DataType.STRING)
  declare kind: string;

  /** Absolute folders inside the container, each under one of the media roots. */
  @Column(DataType.JSON)
  declare folders: string[];

  @Default(true)
  @Column(DataType.BOOLEAN)
  declare enabled: boolean;

  @Column(DataType.DATE)
  declare lastScanAt: Date | null;

  /** One-line result of the last scan, for the admin page. */
  @Column(DataType.TEXT)
  declare lastScanSummary: string | null;
}
