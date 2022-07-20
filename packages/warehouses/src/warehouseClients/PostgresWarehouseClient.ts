import {
    DimensionType,
    FullPostgresCredentials,
    SSHTunnelConfigSecrets,
    WarehouseConnectionError,
    WarehouseQueryError,
} from '@lightdash/common';
import * as pg from 'pg';
import { Pool, PoolConfig } from 'pg';
import SSH2Promise from 'ssh2-promise';
import SSHConfig from 'ssh2-promise/lib/sshConfig';
import { WarehouseClient } from '../types';

const getSSLConfigFromMode = (mode: string): PoolConfig['ssl'] => {
    switch (mode) {
        case 'disable':
            return false;
        case 'no-verify':
            return {
                rejectUnauthorized: false,
            };
        case 'allow':
        case 'prefer':
        case 'require':
        case 'verify-ca':
        case 'verify-full':
            return true;
        default:
            throw new Error(`SSL mode "${mode}" not understood.`);
    }
};

export enum PostgresTypes {
    INTEGER = 'integer',
    INT = 'int',
    INT2 = 'int2',
    INT4 = 'int4',
    INT8 = 'int8',
    MONEY = 'money',
    SMALLSERIAL = 'smallserial',
    SERIAL = 'serial',
    SERIAL2 = 'serial2',
    SERIAL4 = 'serial4',
    SERIAL8 = 'serial8',
    BIGSERIAL = 'bigserial',
    BIGINT = 'bigint',
    SMALLINT = 'smallint',
    BOOLEAN = 'boolean',
    BOOL = 'bool',
    DATE = 'date',
    DOUBLE_PRECISION = 'double precision',
    FLOAT = 'float',
    FLOAT4 = 'float4',
    FLOAT8 = 'float8',
    JSON = 'json',
    JSONB = 'jsonb',
    NUMERIC = 'numeric',
    DECIMAL = 'decimal',
    REAL = 'real',
    CHAR = 'char',
    CHARACTER = 'character',
    NCHAR = 'nchar',
    BPCHAR = 'bpchar',
    VARCHAR = 'varchar',
    CHARACTER_VARYING = 'character varying',
    NVARCHAR = 'nvarchar',
    TEXT = 'text',
    TIME = 'time',
    TIME_TZ = 'timetz',
    TIME_WITHOUT_TIME_ZONE = 'time without time zone',
    TIMESTAMP = 'timestamp',
    TIMESTAMP_TZ = 'timestamptz',
    TIMESTAMP_WITHOUT_TIME_ZONE = 'timestamp without time zone',
}

const mapFieldType = (type: string): DimensionType => {
    switch (type) {
        case PostgresTypes.DECIMAL:
        case PostgresTypes.NUMERIC:
        case PostgresTypes.INTEGER:
        case PostgresTypes.MONEY:
        case PostgresTypes.SMALLSERIAL:
        case PostgresTypes.SERIAL:
        case PostgresTypes.SERIAL2:
        case PostgresTypes.SERIAL4:
        case PostgresTypes.SERIAL8:
        case PostgresTypes.BIGSERIAL:
        case PostgresTypes.INT2:
        case PostgresTypes.INT4:
        case PostgresTypes.INT8:
        case PostgresTypes.BIGINT:
        case PostgresTypes.SMALLINT:
        case PostgresTypes.FLOAT:
        case PostgresTypes.FLOAT4:
        case PostgresTypes.FLOAT8:
        case PostgresTypes.DOUBLE_PRECISION:
        case PostgresTypes.REAL:
            return DimensionType.NUMBER;
        case PostgresTypes.DATE:
            return DimensionType.DATE;
        case PostgresTypes.TIME:
        case PostgresTypes.TIME_TZ:
        case PostgresTypes.TIMESTAMP:
        case PostgresTypes.TIMESTAMP_TZ:
        case PostgresTypes.TIME_WITHOUT_TIME_ZONE:
        case PostgresTypes.TIMESTAMP_WITHOUT_TIME_ZONE:
            return DimensionType.TIMESTAMP;
        case PostgresTypes.BOOLEAN:
        case PostgresTypes.BOOL:
            return DimensionType.BOOLEAN;
        default:
            return DimensionType.STRING;
    }
};

const { builtins } = pg.types;
const convertDataTypeIdToDimensionType = (
    dataTypeId: number,
): DimensionType => {
    switch (dataTypeId) {
        case builtins.NUMERIC:
        case builtins.MONEY:
        case builtins.INT2:
        case builtins.INT4:
        case builtins.INT8:
        case builtins.FLOAT4:
        case builtins.FLOAT8:
            return DimensionType.NUMBER;
        case builtins.DATE:
            return DimensionType.DATE;
        case builtins.TIME:
        case builtins.TIMETZ:
        case builtins.TIMESTAMP:
        case builtins.TIMESTAMPTZ:
            return DimensionType.TIMESTAMP;
        case builtins.BOOL:
            return DimensionType.BOOLEAN;
        default:
            return DimensionType.STRING;
    }
};

type SupportedPoolConfig = Pick<
    PoolConfig,
    'host' | 'port' | 'database' | 'user' | 'password' | 'ssl'
>;
export class PostgresClient implements WarehouseClient {
    config: SupportedPoolConfig;

    sshTunnel?: SSHTunnelConfigSecrets;

    constructor(
        config: SupportedPoolConfig,
        sshTunnel?: SSHTunnelConfigSecrets,
    ) {
        this.config = config;
        this.sshTunnel = sshTunnel;
    }

    private async connect(): Promise<Pool> {
        try {
            const config = { ...this.config };
            if (this.sshTunnel) {
                const sshConfig: SSHConfig = {
                    username: this.sshTunnel.username,
                    privateKey: this.sshTunnel.privateKey,
                    port: this.sshTunnel.port,
                    host: this.sshTunnel.host,
                } as SSHConfig; // force type, ssh2 not recognising these arguments
                const ssh = new SSH2Promise(sshConfig);
                await ssh.connect();
                const tunnel = await ssh.addTunnel({
                    remoteAddr: config.host,
                    remotePort: config.port,
                });
                config.host = 'localhost';
                config.port = tunnel.localPort;
            }
            return new pg.Pool(config);
        } catch (e) {
            throw new WarehouseConnectionError(e.message);
        }
    }

    async runQuery(sql: string) {
        try {
            const pool = await this.connect();
            const results = await pool.query(sql); // automatically checkouts client and cleans up
            const fields = results.fields.reduce(
                (acc, { name, dataTypeID }) => ({
                    ...acc,
                    [name]: {
                        type: convertDataTypeIdToDimensionType(dataTypeID),
                    },
                }),
                {},
            );
            return { fields, rows: results.rows };
        } catch (e) {
            throw new WarehouseQueryError(e.message);
        }
    }

    async test(): Promise<void> {
        await this.runQuery('SELECT 1');
    }

    async getCatalog(
        requests: {
            database: string;
            schema: string;
            table: string;
        }[],
    ) {
        const { databases, schemas, tables } = requests.reduce<{
            databases: Set<string>;
            schemas: Set<string>;
            tables: Set<string>;
        }>(
            (acc, { database, schema, table }) => ({
                databases: acc.databases.add(`'${database}'`),
                schemas: acc.schemas.add(`'${schema}'`),
                tables: acc.tables.add(`'${table}'`),
            }),
            {
                databases: new Set(),
                schemas: new Set(),
                tables: new Set(),
            },
        );
        if (databases.size <= 0 || schemas.size <= 0 || tables.size <= 0) {
            return {};
        }
        const query = `
            SELECT table_catalog,
                   table_schema,
                   table_name,
                   column_name,
                   data_type
            FROM information_schema.columns
            WHERE table_catalog IN (${Array.from(databases)})
              AND table_schema IN (${Array.from(schemas)})
              AND table_name IN (${Array.from(tables)})
        `;

        const { rows } = await this.runQuery(query);
        const catalog = rows.reduce(
            (
                acc,
                {
                    table_catalog,
                    table_schema,
                    table_name,
                    column_name,
                    data_type,
                },
            ) => {
                const match = requests.find(
                    ({ database, schema, table }) =>
                        database === table_catalog &&
                        schema === table_schema &&
                        table === table_name,
                );
                if (match) {
                    acc[table_catalog] = acc[table_catalog] || {};
                    acc[table_catalog][table_schema] =
                        acc[table_catalog][table_schema] || {};
                    acc[table_catalog][table_schema][table_name] =
                        acc[table_catalog][table_schema][table_name] || {};
                    acc[table_catalog][table_schema][table_name][column_name] =
                        mapFieldType(data_type);
                }

                return acc;
            },
            {},
        );
        return catalog;
    }
}

export class PostgresWarehouseClient
    extends PostgresClient
    implements WarehouseClient
{
    constructor(credentials: FullPostgresCredentials) {
        const ssl = credentials.sslmode
            ? getSSLConfigFromMode(credentials.sslmode)
            : undefined;
        super(
            {
                host: encodeURIComponent(credentials.host),
                port: credentials.port,
                database: encodeURIComponent(credentials.dbname),
                user: encodeURIComponent(credentials.user),
                password: encodeURIComponent(credentials.password),
                ssl,
            },
            credentials.sshTunnel,
        );
    }
}
