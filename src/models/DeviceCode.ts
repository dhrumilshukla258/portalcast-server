import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

@Table({
    tableName: "device_codes",
    timestamps: true,
})
export class DeviceCode extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    declare deviceCode: string; // UUID/Random unique string for backend polling

    @Column(DataType.STRING)
    declare userCode: string; // Short 6-char code shown to the user (e.g. AB-CDE)

    @Column(DataType.INTEGER)
    declare userId?: number; // Associated user once authenticated

    @Column(DataType.STRING)
    declare status: string; // 'pending' | 'authorized' | 'expired'

    @Column(DataType.DATE)
    declare expiresAt: Date;
}
