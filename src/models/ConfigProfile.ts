import { encryptConfig, decryptConfig } from "@/config/providerSecrets";
import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Unique, Default } from "sequelize-typescript";
import { Config } from "@/types/domain";

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

    // Provider credentials are encrypted at rest (config/providerSecrets.ts); code that
    // reads `profile.config` gets them decrypted.
    @Column({
        type: DataType.JSON,
        get(this: ConfigProfile) {
            return decryptConfig(this.getDataValue("config"));
        },
        set(this: ConfigProfile, value: Config) {
            this.setDataValue("config", encryptConfig(value));
        },
    })
    declare config: Config;

    @Default(false)
    @Column(DataType.BOOLEAN)
    declare isActive: boolean;

    @Default(true)
    @Column(DataType.BOOLEAN)
    declare isEnabled: boolean;
}
