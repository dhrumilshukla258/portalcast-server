import {
  Table,
  Column,
  Model,
  DataType,
  Index,
  ForeignKey,
  BelongsTo,
} from "sequelize-typescript";
import { ContentMeta } from "@/models/ContentMeta";

// (contentId, value) join table — one row per curated theme bucket (see
// src/content/themes.ts) a ContentMeta item matches via its TMDB keywords.
@Table({ tableName: "content_themes", timestamps: false })
export class ContentTheme extends Model {
  @ForeignKey(() => ContentMeta)
  @Index
  @Column(DataType.STRING)
  declare contentId: string;

  @Index
  @Column(DataType.STRING)
  declare value: string;

  // See ContentGenre.ts for why this exists — denormalized copy of the parent
  // ContentMeta row's isRepresentative, kept in sync by recomputeRepresentatives().
  @Index
  @Column(DataType.BOOLEAN)
  declare isRepresentative: boolean;

  @BelongsTo(() => ContentMeta, { foreignKey: "contentId", targetKey: "id" })
  declare content: ContentMeta;
}
