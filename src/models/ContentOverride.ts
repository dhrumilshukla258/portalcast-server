import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  Index,
} from "sequelize-typescript";

@Table({ tableName: "content_overrides", timestamps: true })
export class ContentOverride extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare item_key: string; // "{type}_{id}" e.g. "movie_12345"

  @Index
  @Column(DataType.STRING)
  declare item_type: string; // "movie" | "series" | "channel"

  @Column({ type: DataType.STRING, allowNull: true })
  declare display_name: string | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare hidden: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  declare target_category_id: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare original_category_id: string | null; // source category, used to resolve moved items

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sort_order: number | null;
}
