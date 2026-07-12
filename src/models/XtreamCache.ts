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

  @Column(DataType.TEXT)
  declare value: string;

  @Column(DataType.DATE)
  declare expiresAt: Date;
}
