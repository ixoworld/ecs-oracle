/**
 * Data Vault Constants
 *
 * Centralized configuration values to eliminate magic numbers
 * and ensure consistency across the data vault module.
 */

export const DATA_VAULT_CONSTANTS = {
  /** Number of sample rows to include in metadata for LLM context */
  SAMPLE_ROW_COUNT: 5,

  /** Threshold for unique values to be considered categorical (for top values) */
  CATEGORICAL_THRESHOLD: 20,

  /** Number of top values to include in column stats */
  TOP_VALUES_COUNT: 5,

  /** Batch size for SQL INSERT statements */
  SQL_INSERT_BATCH_SIZE: 100,

  /** Query timeout in milliseconds (backend) */
  QUERY_TIMEOUT_MS: 30000,

  /** Maximum result rows for queries */
  MAX_RESULT_ROWS: 10000,

  /** Default TTL for vault entries in seconds (30 minutes) */
  DEFAULT_TTL_SECONDS: 30 * 60,

  /** Grace period after fetch in seconds (5 minutes) */
  DEFAULT_GRACE_PERIOD_SECONDS: 5 * 60,

  /** Maximum inline rows before offloading */
  DEFAULT_MAX_INLINE_ROWS: 100,

  /** Maximum inline tokens before offloading (estimated) */
  DEFAULT_MAX_INLINE_TOKENS: 10000,

  /** Maximum inline bytes before offloading (50KB) */
  DEFAULT_MAX_INLINE_BYTES: 50 * 1024,

  /** Characters per token estimate for size calculations */
  CHARS_PER_TOKEN_ESTIMATE: 4,
} as const;

/**
 * Error types for consistent error handling
 */
export const ERROR_TYPES = {
  /** Data not found in vault */
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',

  /** Query execution error */
  QUERY_ERROR: 'QUERY_ERROR',

  /** Data retrieval error */
  RETRIEVAL_ERROR: 'RETRIEVAL_ERROR',

  /** Access denied error */
  ACCESS_DENIED: 'ACCESS_DENIED',

  /** Invalid access token */
  INVALID_TOKEN: 'INVALID_TOKEN',

  /** Validation error */
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  /** Timeout error */
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
} as const;

/**
 * Redis key prefixes
 */
export const REDIS_PREFIXES = {
  /** Prefix for vault entries */
  VAULT: 'data-vault:',

  /** Prefix for query cache (if implemented) */
  QUERY_CACHE: 'query-cache:',
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];
