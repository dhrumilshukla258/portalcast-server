import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

@Table({
    tableName: "user_progress",
    timestamps: true,
})
export class UserProgress extends Model {
    @PrimaryKey
    @Column(DataType.INTEGER)
    declare userId: number;

    @PrimaryKey
    @Column(DataType.INTEGER)
    declare profileId: number;

    @PrimaryKey
    @Column(DataType.STRING)
    declare mediaId: string;

    @Column(DataType.FLOAT)
    declare progress: number; // time in seconds

    @Column(DataType.BOOLEAN)
    declare completed: boolean;

    @Column(DataType.JSON)
    declare meta: Record<string, any>;
}
