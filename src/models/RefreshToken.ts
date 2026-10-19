import { Table, Column, Model, DataType, PrimaryKey, Index } from "sequelize-typescript";

// Every refresh token the server has issued, by SHA-256 of the token (the token itself
// is never stored). Lets a session be revoked (sign-out, account disabled, admin action)
// and detects a stolen token being replayed after rotation. See services/RefreshTokens.ts.
@Table({ tableName: "refresh_tokens", timestamps: true })
export class RefreshToken extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  declare tokenHash: string;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  /** All rotations of one sign-in share a family; a replayed token revokes the family. */
  @Index
  @Column({ type: DataType.STRING, allowNull: false })
  declare family: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare clientType: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastUsedAt: Date | null;

  /** Set when rotated away or revoked; a token with this set must never be accepted. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare revokedReason: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare ip: string | null;
}
