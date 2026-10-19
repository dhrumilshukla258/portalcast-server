import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Index } from "sequelize-typescript";

// One row per suspicious or security-relevant event (failed sign-ins, rejected tokens,
// forbidden admin attempts, bans, ...). Written in batches by services/SecurityEvents.ts,
// shown under Admin > Security, purged after 30 days.
@Table({ tableName: "security_events", timestamps: false })
export class SecurityEvent extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare kind: string;

  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare ip: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare userId: number | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare path: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare detail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare userAgent: string | null;

  @Index
  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
