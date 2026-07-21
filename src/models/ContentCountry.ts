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

// (contentId, value) join table — one row per production country a ContentMeta item
// is associated with. See ContentGenre.ts for the indexing rationale.
@Table({ tableName: "content_countries", timestamps: false })
export class ContentCountry extends Model {
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
