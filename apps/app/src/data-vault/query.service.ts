import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

/**
 * Recursively convert BigInt values to Numbers for JSON serialization
 */
function convertBigIntToNumber(obj: unknown): unknown {
  if (typeof obj === 'bigint') {
    return Number(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToNumber);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertBigIntToNumber(value);
    }
    return result;
  }
  return obj;
}

/**
 * Result from executing a SQL query on vaulted data
 */
export interface QueryResult {
  /** Query result rows */
  rows: Record<string, unknown>[];
  /** Number of rows returned */
  rowCount: number;
  /** Column names in result */
  columns: string[];
  /** Query execution time in ms */
  executionTimeMs: number;
  /** Whether result was truncated due to limits */
  truncated: boolean;
}

/**
 * Result from retrieving full vaulted data
 */
export interface RetrieveResult {
  /** Full data array */
  data: unknown[];
  /** Number of rows */
  rowCount: number;
  /** Data size in bytes */
  sizeBytes: number;
  /** Whether limit was applied */
  limitApplied: boolean;
  /** Token estimate (data size / 4) */
  estimatedTokens: number;
}

/**
 * Parameters for executing a query
 */
export interface ExecuteQueryParams {
  /** Handle ID of the vaulted data */
  handleId: string;
  /** SQL query to execute (use {table} as table placeholder) */
  sql: string;
  /** User DID for ownership validation */
  userDid: string;
  /** Access token for authentication */
  accessToken: string;
}

/**
 * Parameters for retrieving full data
 */
export interface RetrieveFullDataParams {
  /** Handle ID of the vaulted data */
  handleId: string;
  /** User DID for ownership validation */
  userDid: string;
  /** Access token for authentication */
  accessToken: string;
  /** Optional limit on rows returned (for safety) */
  limit?: number;
}

/**
 * Internal storage entry structure (must match DataVaultService)
 */
interface VaultEntry {
  fullData: unknown[];
  metadata: Record<string, unknown>;
  userDid: string;
  sessionId: string;
  createdAt: number;
  accessToken: string;
}

/**
 * Data Vault Query Service
 *
 * Provides server-side SQL querying of vaulted data using DuckDB.
 * This allows the oracle to run aggregations, filters, and other SQL
 * operations without loading full datasets into the LLM context.
 *
 * Key features:
 * - Native DuckDB performance (~35ms queries)
 * - Load → Query → Drop pattern for memory safety
 * - Access token validation for security
 * - Query timeout protection (30s)
 * - Result row limits (10k max)
 */
@Injectable()
export class DataVaultQueryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataVaultQueryService.name);
  private readonly VAULT_PREFIX = 'data-vault:';
  private readonly QUERY_TIMEOUT_MS = 30000; // 30 seconds
  private readonly MAX_RESULT_ROWS = 10000;

  private redis: Redis;
  private instance: DuckDBInstance;
  private connection: DuckDBConnection;

  private redisUrl: string;

  constructor(config: { redisUrl: string }) {
    this.redisUrl = config.redisUrl;
  }

  async onModuleInit(): Promise<void> {
    // Initialize Redis connection
    this.redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });

    this.redis.on('connect', () => {
      this.logger.log('DataVaultQuery Redis Client Connected');
    });

    await this.redis.connect();

    // Initialize DuckDB (in-memory database)
    this.instance = await DuckDBInstance.create(':memory:');
    this.connection = await this.instance.connect();

    this.logger.log('DataVaultQueryService initialized with DuckDB');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      this.connection.closeSync();
    }
    if (this.instance) {
      this.instance.closeSync();
    }
    if (this.redis) {
      await this.redis.quit();
      this.logger.log('DataVaultQuery Redis connection closed');
    }
  }

  /**
   * Execute SQL query on vaulted data
   *
   * @param params Query parameters
   * @returns Query result with rows and metadata
   */
  async executeQuery(params: ExecuteQueryParams): Promise<QueryResult> {
    const { handleId, sql, userDid, accessToken } = params;
    const startTime = Date.now();

    this.logger.log(`Query: handle=${handleId} user=${userDid.slice(-8)} sql="${sql.substring(0, 80)}..."`);

    // Retrieve and validate data
    const entry = await this.getVaultEntry(handleId, userDid, accessToken);
    if (!entry) {
      throw new Error('Data not found, expired, or access denied');
    }

    const tableName = `vault_${handleId.replace(/-/g, '_')}`;

    try {
      // Load data into DuckDB temp table
      await this.loadDataIntoTable(tableName, entry.fullData);

      // Replace {table} placeholder with actual table name
      const executableSql = sql.replace(/\{table\}/g, tableName);

      // Add LIMIT if not present to prevent huge results
      const limitedSql = this.ensureLimit(executableSql);

      // Execute query with timeout
      const rows = await this.runQueryWithTimeout(limitedSql);

      const executionTimeMs = Date.now() - startTime;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const truncated = rows.length >= this.MAX_RESULT_ROWS;

      this.logger.log(`Query complete: ${rows.length} rows in ${executionTimeMs}ms`);

      return {
        rows,
        rowCount: rows.length,
        columns,
        executionTimeMs,
        truncated,
      };
    } finally {
      // Always cleanup - drop the temp table
      await this.dropTable(tableName);
    }
  }

  /**
   * Retrieve full data from vault
   *
   * @param params Retrieval parameters
   * @returns Full data with metadata
   */
  async retrieveFullData(params: RetrieveFullDataParams): Promise<RetrieveResult> {
    const { handleId, userDid, accessToken, limit } = params;

    this.logger.log(`RetrieveFull: handle=${handleId} user=${userDid.slice(-8)} limit=${limit ?? 'none'}`);

    // Retrieve and validate data
    const entry = await this.getVaultEntry(handleId, userDid, accessToken);
    if (!entry) {
      throw new Error('Data not found, expired, or access denied');
    }

    let data = entry.fullData;
    let limitApplied = false;

    // Apply limit if specified
    if (limit && data.length > limit) {
      data = data.slice(0, limit);
      limitApplied = true;
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    const estimatedTokens = Math.ceil(sizeBytes / 4);

    this.logger.log(`Retrieved: ${data.length} rows, ${(sizeBytes / 1024).toFixed(2)}KB (~${estimatedTokens} tokens)`);

    return {
      data,
      rowCount: data.length,
      sizeBytes,
      limitApplied,
      estimatedTokens,
    };
  }

  /**
   * Get vault entry with validation
   */
  private async getVaultEntry(
    handleId: string,
    userDid: string,
    accessToken: string,
  ): Promise<VaultEntry | null> {
    const key = `${this.VAULT_PREFIX}${handleId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Handle not found: ${handleId}`);
      return null;
    }

    const entry: VaultEntry = JSON.parse(data);

    // Validate ownership
    if (entry.userDid !== userDid) {
      this.logger.warn(`Access denied: handle owned by different user`);
      return null;
    }

    // Validate access token
    if (entry.accessToken !== accessToken) {
      this.logger.warn(`Access denied: invalid token`);
      return null;
    }

    return entry;
  }

  /**
   * Load array data into a DuckDB temporary table
   */
  private async loadDataIntoTable(tableName: string, data: unknown[]): Promise<void> {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Data must be a non-empty array');
    }

    // Get column info from first row
    const firstRow = data[0] as Record<string, unknown>;
    const columns = Object.keys(firstRow);

    // Infer types and create table
    const columnDefs = columns
      .map((col) => {
        const sampleValue = firstRow[col];
        const duckType = this.inferDuckDBType(sampleValue);
        return `"${col}" ${duckType}`;
      })
      .join(', ');

    const createSql = `CREATE TABLE ${tableName} (${columnDefs})`;

    try {
      await this.connection.run(createSql);

      // Insert data using individual INSERT statements
      for (const row of data) {
        const record = row as Record<string, unknown>;
        const values = columns
          .map((col) => {
            const val = record[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return String(val);
          })
          .join(', ');
        await this.connection.run(`INSERT INTO ${tableName} VALUES (${values})`);
      }

      this.logger.debug(`   Loaded ${data.length} rows into ${tableName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load data into table: ${message}`);
    }
  }

  /**
   * Run query with timeout protection
   */
  private async runQueryWithTimeout(sql: string): Promise<Record<string, unknown>[]> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Query timeout after ${this.QUERY_TIMEOUT_MS}ms`));
      }, this.QUERY_TIMEOUT_MS);
    });

    const queryPromise = (async () => {
      try {
        const reader = await this.connection.runAndReadAll(sql);
        const rows = reader.getRowObjects() as Record<string, unknown>[];
        // Convert BigInt values to Numbers for JSON serialization
        return rows.map(row => convertBigIntToNumber(row) as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Query failed: ${message}`);
      }
    })();

    return Promise.race([queryPromise, timeoutPromise]);
  }

  /**
   * Drop temporary table
   */
  private async dropTable(tableName: string): Promise<void> {
    await this.connection.run(`DROP TABLE IF EXISTS ${tableName}`);
    this.logger.debug(`   Dropped table ${tableName}`);
  }

  /**
   * Ensure query has a LIMIT clause for safety
   */
  private ensureLimit(sql: string): string {
    const upperSql = sql.toUpperCase();
    if (!upperSql.includes('LIMIT')) {
      return `${sql} LIMIT ${this.MAX_RESULT_ROWS}`;
    }
    return sql;
  }

  /**
   * Infer DuckDB type from JavaScript value
   */
  private inferDuckDBType(value: unknown): string {
    if (value === null || value === undefined) {
      return 'VARCHAR';
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
    }
    if (typeof value === 'boolean') {
      return 'BOOLEAN';
    }
    if (value instanceof Date) {
      return 'TIMESTAMP';
    }
    if (typeof value === 'string') {
      // Check if it looks like a date
      const datePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
      if (datePattern.test(value)) {
        return 'TIMESTAMP';
      }
    }
    // Arrays and objects stored as JSON strings
    return 'VARCHAR';
  }
}
