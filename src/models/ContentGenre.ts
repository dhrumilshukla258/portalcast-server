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

// (contentId, value) join table — one row per genre a ContentMeta item belongs to.
// Indexed on `value` so "all movies tagged Action" is a fast indexed lookup instead
// of a JSON-blob scan or a LIKE '%x%' query across 100k+ rows.
@Table({ tableName: "content_genres", timestamps: false })
export class ContentGenre extends Model {
  @ForeignKey(() => ContentMeta)
  @Index
  @Column(DataType.STRING)
  declare contentId: string;

  @Index
  @Column(DataType.STRING)
  declare value: string;

  // Denormalized copy of the parent ContentMeta row's isRepresentative flag,
  // kept in sync by recomputeRepresentatives() (metaEnrichment.ts) whenever it
  // runs. Lets facet counting filter to one-row-per-title directly on this
  // table with a plain indexed WHERE, instead of joining back to ContentMeta —
  // that join, made unconditional during the title-grouping work, turned a
  // cheap single-table GROUP BY into a full scan across this table (~850k
  // rows) on every Discover page load and took the whole server down.
  @Index
  @Column(DataType.BOOLEAN)
  declare isRepresentative: boolean;

  @BelongsTo(() => ContentMeta, { foreignKey: "contentId", targetKey: "id" })
  declare content: ContentMeta;
}
