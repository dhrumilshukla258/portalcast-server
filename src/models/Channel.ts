import {
    Table,
    Column,
    Model,
    DataType,
    PrimaryKey,
    Index,
} from "sequelize-typescript";

@Table({
    tableName: "channels",
    timestamps: true,
})
export class Channel extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    declare id: string;

    @Column(DataType.STRING)
    declare name: string;

    @Column(DataType.TEXT)
    declare cmd: string;

    @Column(DataType.STRING)
    declare logo: string;

    @Index
    @Column(DataType.STRING)
    declare tv_genre_id: string;

    @Column(DataType.STRING)
    declare censored: string;

    @Column(DataType.INTEGER)
    declare number?: number;

    @Index
    @Column(DataType.INTEGER)
    declare profileId?: number;
}
