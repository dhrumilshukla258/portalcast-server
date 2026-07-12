import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  AutoIncrement,
  Index,
} from "sequelize-typescript";

@Table({
  tableName: "epg_cache",
  timestamps: true,
})
export class EpgCache extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column(DataType.DATE)
  declare timestamp: Date;

  @Column(DataType.TEXT)
  declare data: string;

  @Index
  @Column(DataType.INTEGER)
  declare profileId?: number;
}
