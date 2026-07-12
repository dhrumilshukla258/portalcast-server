import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
} from "sequelize-typescript";

@Table({ tableName: "genre_overrides", timestamps: true })
export class GenreOverride extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare genre_key: string; // "{type}_{genre_id}" e.g. "movie_42"

  @Column({ type: DataType.STRING, allowNull: true })
  declare display_name: string | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare hidden: boolean;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sort_order: number | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare virtual: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  declare virtual_title: string | null;
}
