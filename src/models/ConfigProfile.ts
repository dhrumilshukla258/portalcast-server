import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Unique, Default } from "sequelize-typescript";
import { Config } from "@/types/types";

@Table({
    tableName: "config_profiles",
    timestamps: true,
})
export class ConfigProfile extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    declare id: number;

    @Unique
    @Column(DataType.STRING)
    declare name: string;

    @Column(DataType.TEXT)
    declare description?: string;

    @Column(DataType.JSON)
    declare config: Config;

    @Default(false)
    @Column(DataType.BOOLEAN)
    declare isActive: boolean;

    @Default(true)
    @Column(DataType.BOOLEAN)
    declare isEnabled: boolean;
}
