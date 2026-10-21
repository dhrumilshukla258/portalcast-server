import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
} from "sequelize-typescript";

@Table({
  tableName: "xtream_cache",
  timestamps: false,
})
export class XtreamCache extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare key: string;

  /** JSON text, or zlib-compressed JSON as a BLOB for values over 2 KB (services/xtreamCache.ts). */
  @Column(DataType.TEXT)
  declare value: string | Buffer;

  @Column(DataType.DATE)
  declare expiresAt: Date;
}
