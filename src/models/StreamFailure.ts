import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  AutoIncrement,
  Default,
  Index,
} from "sequelize-typescript";

// One row per (profile, item) whose stream failed to play — the admin
// "Broken streams" view. See docs/skill-stream-failures.md.
@Table({
  tableName: "stream_failures",
  timestamps: true,
  indexes: [{ unique: true, fields: ["profileId", "itemType", "itemId"] }],
})
export class StreamFailure extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare profileId: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare itemType: "movie" | "episode" | "live";

  @Column({ type: DataType.STRING, allowNull: false })
  declare itemId: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare title: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare category: string | null;

  // Distinct playback attempts that failed inside the current 24h window.
  @Default(0)
  @Column(DataType.INTEGER)
  declare failureCount: number;

  // attemptIds already counted in the current window (capped, newest last).
  @Column({ type: DataType.JSON, allowNull: true })
  declare attemptTokens: string[] | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare lastStatus: number | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare lastError: string | null;

  // Host only — never the full URL (it can carry upstream credentials).
  @Column({ type: DataType.STRING, allowNull: true })
  declare upstreamHost: string | null;

  // Server-side only (may hold the real upstream cmd) — never returned by the API.
  @Column({ type: DataType.JSON, allowNull: true })
  declare resolveParams: { id?: string; series?: string; cmd?: string } | null;

  // false when itemId was only an unverified fallback (older client) — never auto-hide those.
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare hideable: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare firstFailedAt: Date | null;

  @Index
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastFailedAt: Date | null;

  // True only when THIS feature set ContentOverride.hidden — the marker that
  // makes "unhide" safe (an item an admin hid manually is never touched).
  @Default(false)
  @Column(DataType.BOOLEAN)
  declare autoHidden: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare autoHiddenAt: Date | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare dismissed: boolean;
}
