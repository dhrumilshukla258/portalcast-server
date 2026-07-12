import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Unique, Default } from "sequelize-typescript";

@Table({
    tableName: "users",
    timestamps: true,
})
export class User extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    declare id: number;

    @Unique
    @Column(DataType.STRING)
    declare email: string;

    @Column(DataType.STRING)
    declare name: string;

    @Default("user")
    @Column(DataType.STRING)
    declare role: string; // 'admin' | 'user'

    @Default(true)
    @Column(DataType.BOOLEAN)
    declare isActive: boolean;

    @Column(DataType.JSON)
    declare preferences?: {
        preferredContentType?: "movie" | "series" | "tv";
        favorites?: string[];
        recentChannels?: string[];
        videoFitMode?: string;
        lastSelectedCategory?: Record<string, string>;
        lastSelectedCategoryTitle?: Record<string, string>;
    };

    @Column(DataType.STRING)
    declare passwordHash?: string;

    @Column(DataType.STRING)
    declare salt?: string;

    @Column(DataType.STRING)
    declare avatarUrl?: string;

    @Column(DataType.STRING)
    declare resetToken?: string;

    @Column(DataType.DATE)
    declare resetTokenExpires?: Date;

    @Column(DataType.DATE)
    declare lastLogin?: Date;

    // Per-user OpenSubtitles account link. Search uses the shared server-wide
    // API key regardless, but downloads are quota-limited per OpenSubtitles
    // account (20/day free tier, up to 1000/day VIP) — linking lets each app
    // user draw from their own quota instead of everyone sharing one. The
    // password must be recoverable (not just hashed) since OpenSubtitles has
    // no refresh-token flow — only re-login with the original credentials
    // when the 24h JWT expires. See src/auth/crypto.ts / src/content/opensubtitles.ts.
    @Column(DataType.STRING)
    declare openSubtitlesUsername?: string;

    @Column(DataType.TEXT)
    declare openSubtitlesPasswordEnc?: string;
}
