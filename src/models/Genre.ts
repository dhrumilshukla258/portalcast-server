import {
    Table,
    Column,
    Model,
    DataType,
    PrimaryKey,
    Index,
} from "sequelize-typescript";

export type GenreType = "channel" | "movie" | "series";

@Table({
    tableName: "genres",
    timestamps: true,
})
export class Genre extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    declare id: string;

    @Column(DataType.STRING)
    declare title: string;

    @Column(DataType.INTEGER)
    declare number: number;

    @Column(DataType.STRING)
    declare alias: string;

    @Column(DataType.INTEGER)
    declare censored: number;

    @Index
    @Column(DataType.STRING)
    declare type: GenreType;

    @Index
    @Column(DataType.INTEGER)
    declare profileId?: number;
}
