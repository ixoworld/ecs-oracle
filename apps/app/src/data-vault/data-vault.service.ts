import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

/**
 * Configuration for data vault thresholds
 */
export interface DataVaultConfig {
  /** Maximum number of rows before offloading (default: 100) */
  maxInlineRows: number;
  /** Maximum estimated tokens before offloading (default: 10000) */
  maxInlineTokens: number;
  /** Maximum bytes before offloading (default: 50KB) */
  maxInlineBytes: number;
  /** TTL for cached data in seconds (default: 30 minutes = 1800) */
  ttlSeconds: number;
  /** Grace period after fetch in seconds (default: 5 minutes = 300) */
  gracePeriodSeconds: number;
  /** Redis URL for storage */
  redisUrl: string;
}

/**
 * Column schema information extracted from data
 */
export interface ColumnSchema {
  column: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null';
  nullable: boolean;
}

/**
 * Column statistics for LLM context
 */
export interface ColumnStats {
  column: string;
  unique?: number;
  topValues?: (string | number)[];
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  nullCount?: number;
}

/**
 * Data source information for reproducibility
 */
export interface DataSource {
  /** MCP tool name that produced this data */
  toolName: string;
  /** Arguments passed to the MCP tool */
  toolArgs?: Record<string, unknown>;
  /** User's natural language query */
  userQuery?: string;
  /** When this data was produced */
  timestamp: number;
}

/**
 * Semantic analysis from data analysis sub-agent
 */
export interface SemanticAnalysis {
  /** Human-readable description of what this data represents */
  description: string;
  /** Classification of data structure */
  dataType:
    | 'timeseries'
    | 'tabular'
    | 'hierarchical'
    | 'geospatial'
    | 'text'
    | 'mixed';
  /** Suggested AG-UI visualization tools */
  suggestedVisualizations: string[];
  /** Why these visualizations fit */
  visualizationRationale: string;
  /** Data quality notes */
  qualityInsights: string[];
  /** Additional metadata enhancements from analysis */
  enhancements: Record<string, unknown>;
}

/**
 * Metadata returned to LLM instead of full data
 */
export interface DataVaultMetadata {
  /** Unique handle ID for this data */
  handleId: string;
  /** Access token required for fetching data (MUST be included in AG-UI tool calls) */
  fetchToken: string;
  /** Name of the source MCP tool */
  sourceTool: string;
  /** Schema of the data */
  schema: ColumnSchema[];
  /** Total number of rows */
  rowCount: number;
  /** Sample rows for LLM context (5 rows) */
  sampleRows: Record<string, unknown>[];
  /** Statistics per column */
  columnStats: ColumnStats[];
  /** Data source info for reproducibility */
  dataSource?: DataSource;
  /** Semantic analysis from sub-agent (what this data represents and how to visualize it) */
  semantics?: SemanticAnalysis;
  /** Marker to indicate data was offloaded */
  _dataOffloaded: true;
  /** Instructions for LLM */
  _note: string;
}

/**
 * Internal storage entry (stored in Redis as JSON)
 */
interface VaultEntry {
  /** Full data array */
  fullData: unknown[];
  /** Extracted metadata */
  metadata: DataVaultMetadata;
  /** User DID who owns this data */
  userDid: string;
  /** Session ID this data belongs to */
  sessionId: string;
  /** When this entry was created */
  createdAt: number;
  /**
   * Access token for secure fetch
   * NOTE: Tokens are REUSABLE within the TTL period (not truly one-time).
   * This allows retry on network failures and multiple component fetches.
   * Tokens become invalid when the entry expires or is deleted.
   */
  accessToken: string;
}

/**
 * Result of storing data in the vault
 */
export interface StoreResult {
  /** The metadata to return to LLM */
  metadata: DataVaultMetadata;
  /** The generated handle ID */
  handleId: string;
}

/**
 * Data Vault Service - Redis-backed storage for large MCP results
 *
 * This service stores large datasets temporarily so that:
 * 1. LLM only sees metadata (schema, sample, stats)
 * 2. Frontend can fetch full data when needed via secure endpoint
 * 3. Data is automatically cleaned up via Redis TTL
 *
 * Uses Redis for storage to avoid server memory spikes.
 */
@Injectable()
export class DataVaultService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataVaultService.name);
  private readonly config: DataVaultConfig;
  private readonly VAULT_PREFIX = 'data-vault:';
  private redis: Redis;

  constructor(config: Partial<DataVaultConfig> & { redisUrl: string }) {
    this.config = {
      maxInlineRows: config?.maxInlineRows ?? 100,
      maxInlineTokens: config?.maxInlineTokens ?? 10000,
      maxInlineBytes: config?.maxInlineBytes ?? 50 * 1024, // 50KB
      ttlSeconds: config?.ttlSeconds ?? 30 * 60, // 30 minutes
      gracePeriodSeconds: config?.gracePeriodSeconds ?? 5 * 60, // 5 minutes
      redisUrl: config.redisUrl,
    };
  }

  async onModuleInit(): Promise<void> {
    this.redis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });

    this.redis.on('connect', () => {
      this.logger.log('DataVault Redis Client Connected');
    });

    await this.redis.connect();
    this.logger.log(
      `DataVault initialized with Redis storage: maxRows=${this.config.maxInlineRows}, ttl=${this.config.ttlSeconds / 60}min`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.logger.log('DataVault Redis connection closed');
    }
  }

  /**
   * Check if data should be offloaded based on size thresholds
   */
  shouldOffload(data: unknown): boolean {
    if (!Array.isArray(data)) {
      return false;
    }

    // Check row count
    if (data.length > this.config.maxInlineRows) {
      return true;
    }

    // Check byte size
    const jsonStr = JSON.stringify(data);
    if (jsonStr.length > this.config.maxInlineBytes) {
      return true;
    }

    // Estimate tokens (rough: 4 chars per token)
    const estimatedTokens = jsonStr.length / 4;
    if (estimatedTokens > this.config.maxInlineTokens) {
      return true;
    }

    return false;
  }

  /**
   * Store large data in Redis and return metadata for LLM
   */
  async store(
    data: unknown[],
    userDid: string,
    sessionId: string,
    sourceTool: string,
    dataSourceInfo?: Partial<Omit<DataSource, 'toolName' | 'timestamp'>>,
    semanticAnalysis?: SemanticAnalysis,
  ): Promise<StoreResult> {
    const handleId = `vault-${randomUUID()}`;
    const accessToken = randomUUID();
    const now = Date.now();

    // Build data source info
    const dataSource: DataSource | undefined = dataSourceInfo
      ? {
          toolName: sourceTool,
          toolArgs: dataSourceInfo.toolArgs,
          userQuery: dataSourceInfo.userQuery,
          timestamp: now,
        }
      : undefined;

    // Extract metadata
    const metadata = this.extractMetadata(
      data,
      handleId,
      sourceTool,
      accessToken,
      dataSource,
      semanticAnalysis,
    );

    const entry: VaultEntry = {
      fullData: data,
      metadata,
      userDid,
      sessionId,
      createdAt: now,
      accessToken,
    };

    // Store in Redis with TTL
    const key = `${this.VAULT_PREFIX}${handleId}`;
    await this.redis.set(
      key,
      JSON.stringify(entry),
      'EX',
      this.config.ttlSeconds,
    );

    const dataSizeKB = (
      Buffer.byteLength(JSON.stringify(data), 'utf8') / 1024
    ).toFixed(2);

    this.logger.log(`Stored: handle=${handleId} user=${userDid.slice(-8)} rows=${data.length} size=${dataSizeKB}KB ttl=${this.config.ttlSeconds}s`);

    return { metadata, handleId };
  }

  /**
   * Retrieve data from Redis for frontend fetch
   * Validates ownership, access token, and reduces TTL to grace period
   *
   * @param handleId - The vault handle ID
   * @param userDid - User DID for ownership validation
   * @param accessToken - Optional access token for additional security validation
   */
  async retrieve(
    handleId: string,
    userDid: string,
    accessToken?: string,
  ): Promise<unknown[] | null> {
    this.logger.log(`Retrieve: handle=${handleId} user=${userDid.slice(-8)}`);

    const key = `${this.VAULT_PREFIX}${handleId}`;

    // Use WATCH for optimistic locking to ensure atomic read-validate-expire
    await this.redis.watch(key);

    try {
      const data = await this.redis.get(key);

      if (!data) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: handle not found`);
        return null;
      }

      const entry: VaultEntry = JSON.parse(data);

      // Validate ownership
      if (entry.userDid !== userDid) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: access denied`);
        return null;
      }

      // Validate access token if provided
      if (accessToken && entry.accessToken !== accessToken) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: invalid access token`);
        return null;
      }

      // Use MULTI/EXEC for atomic TTL reduction
      const pipeline = this.redis.multi();
      pipeline.expire(key, this.config.gracePeriodSeconds);
      const results = await pipeline.exec();

      // Check if transaction succeeded (returns null if WATCH detected changes)
      if (!results) {
        this.logger.warn(`Retrieve: concurrent modification, retrying`);
        // Retry once on concurrent modification
        return this.retrieve(handleId, userDid, accessToken);
      }

      const dataSizeKB = (
        Buffer.byteLength(JSON.stringify(entry.fullData), 'utf8') / 1024
      ).toFixed(2);
      this.logger.log(`Retrieved: rows=${entry.fullData.length} size=${dataSizeKB}KB grace=${this.config.gracePeriodSeconds}s`);

      return entry.fullData;
    } catch (error) {
      await this.redis.unwatch();
      throw error;
    }
  }

  /**
   * Retrieve data AND metadata from Redis for frontend fetch
   * Validates ownership, access token, and reduces TTL to grace period
   *
   * @param handleId - The vault handle ID
   * @param userDid - User DID for ownership validation
   * @param accessToken - Optional access token for additional security validation
   */
  async retrieveWithMetadata(
    handleId: string,
    userDid: string,
    accessToken?: string,
  ): Promise<{ data: unknown[]; metadata: DataVaultMetadata } | null> {
    this.logger.log(`RetrieveWithMetadata: handle=${handleId} user=${userDid.slice(-8)}`);

    const key = `${this.VAULT_PREFIX}${handleId}`;

    // Use WATCH for optimistic locking to ensure atomic read-validate-expire
    await this.redis.watch(key);

    try {
      const data = await this.redis.get(key);

      if (!data) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: handle not found`);
        return null;
      }

      const entry: VaultEntry = JSON.parse(data);

      // Validate ownership
      if (entry.userDid !== userDid) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: access denied`);
        return null;
      }

      // Validate access token if provided
      if (accessToken && entry.accessToken !== accessToken) {
        await this.redis.unwatch();
        this.logger.warn(`Retrieve failed: invalid access token`);
        return null;
      }

      // Use MULTI/EXEC for atomic TTL reduction
      const pipeline = this.redis.multi();
      pipeline.expire(key, this.config.gracePeriodSeconds);
      const results = await pipeline.exec();

      // Check if transaction succeeded (returns null if WATCH detected changes)
      if (!results) {
        this.logger.warn(`Retrieve: concurrent modification, retrying`);
        // Retry once on concurrent modification
        return this.retrieveWithMetadata(handleId, userDid, accessToken);
      }

      const dataSizeKB = (
        Buffer.byteLength(JSON.stringify(entry.fullData), 'utf8') / 1024
      ).toFixed(2);
      this.logger.log(`Retrieved: rows=${entry.fullData.length} size=${dataSizeKB}KB grace=${this.config.gracePeriodSeconds}s`);

      return {
        data: entry.fullData,
        metadata: entry.metadata,
      };
    } catch (error) {
      await this.redis.unwatch();
      throw error;
    }
  }

  /**
   * Validate access token for a handle
   */
  async validateAccessToken(
    handleId: string,
    accessToken: string,
  ): Promise<boolean> {
    const key = `${this.VAULT_PREFIX}${handleId}`;
    const data = await this.redis.get(key);

    if (!data) {
      return false;
    }

    const entry: VaultEntry = JSON.parse(data);
    return entry.accessToken === accessToken;
  }

  /**
   * Extract metadata from data array for LLM context
   * Note: Extraction paths are now intelligently determined by data-analysis sub-agent
   */
  private extractMetadata(
    data: unknown[],
    handleId: string,
    sourceTool: string,
    accessToken: string,
    dataSource?: DataSource,
    semanticAnalysis?: SemanticAnalysis,
  ): DataVaultMetadata {
    if (data.length === 0) {
      return {
        handleId,
        fetchToken: accessToken,
        sourceTool,
        schema: [],
        rowCount: 0,
        sampleRows: [],
        columnStats: [],
        dataSource,
        semantics: semanticAnalysis,
        _dataOffloaded: true,
        _note: `Data was offloaded due to size. Use query_vaulted_data if needed:
- dataHandle: "${handleId}"
- fetchToken: "${accessToken}"

For AG-UI visualization tools, include BOTH dataHandle and fetchToken.`,
      };
    }

    // Get schema from first row
    const firstRow = data[0] as Record<string, unknown>;
    const columns = Object.keys(firstRow);
    const schema: ColumnSchema[] = columns.map((col) => ({
      column: col,
      type: this.inferType(firstRow[col]),
      nullable: data.some(
        (row) =>
          (row as Record<string, unknown>)[col] === null ||
          (row as Record<string, unknown>)[col] === undefined,
      ),
    }));

    // Get sample rows (first 5)
    const sampleRows = data.slice(0, 5) as Record<string, unknown>[];

    // Calculate column statistics
    const columnStats: ColumnStats[] = columns.map((col) => {
      const values = data
        .map((row) => (row as Record<string, unknown>)[col])
        .filter((v) => v !== null && v !== undefined);

      const stats: ColumnStats = {
        column: col,
        nullCount: data.length - values.length,
      };

      // Calculate unique values
      const uniqueSet = new Set(values.map((v) => JSON.stringify(v)));
      stats.unique = uniqueSet.size;

      // Get top values for categorical columns (if not too many unique values)
      if (stats.unique <= 20) {
        const valueCounts = new Map<string, number>();
        values.forEach((v) => {
          const key = String(v);
          valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
        });
        const sortedValues = Array.from(valueCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([v]) => v);
        stats.topValues = sortedValues;
      }

      // Calculate numeric statistics
      const numericValues = values.filter(
        (v) => typeof v === 'number',
      ) as number[];
      if (numericValues.length > 0) {
        stats.min = Math.min(...numericValues);
        stats.max = Math.max(...numericValues);
        stats.sum = numericValues.reduce((a, b) => a + b, 0);
        stats.avg = stats.sum / numericValues.length;
      }

      return stats;
    });

    return {
      handleId,
      fetchToken: accessToken,
      sourceTool,
      schema,
      rowCount: data.length,
      sampleRows,
      columnStats,
      dataSource,
      semantics: semanticAnalysis,
      _dataOffloaded: true,
      _note: `⚠️ WARNING: sampleRows shows ONLY ${sampleRows.length} of ${data.length} rows.
DO NOT answer questions based on sampleRows - they may be unrepresentative.

For ACCURATE answers to data questions, you MUST use query_vaulted_data with:
- dataHandle: "${handleId}"
- fetchToken: "${accessToken}"
- sql: "SELECT ... FROM {table} WHERE ..."

Example: SELECT COUNT(*) FROM {table} WHERE status = 'active'

The sample is for SCHEMA UNDERSTANDING only, NOT for answering questions.

For AG-UI visualization tools, include BOTH dataHandle and fetchToken:
{
  "dataHandle": "${handleId}",
  "fetchToken": "${accessToken}",
  "columns": [...],
  "title": "..."
}`,
    };
  }

  /**
   * Infer JavaScript type from a value
   */
  private inferType(
    value: unknown,
  ): 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null' {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value instanceof Date) {
      return 'date';
    }
    if (typeof value === 'object') {
      return 'object';
    }
    if (typeof value === 'number') {
      return 'number';
    }
    if (typeof value === 'boolean') {
      return 'boolean';
    }
    // Check if string looks like a date
    if (typeof value === 'string') {
      const datePattern =
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;
      if (datePattern.test(value)) {
        return 'date';
      }
    }
    return 'string';
  }
}
