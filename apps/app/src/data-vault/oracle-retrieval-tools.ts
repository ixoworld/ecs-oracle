import { DynamicStructuredTool } from 'langchain';
import { z } from 'zod';
import { DataVaultQueryService } from './query.service';
import { Logger } from '@nestjs/common';

const logger = new Logger('OracleRetrievalTools');

/**
 * Create oracle retrieval tools for accessing vaulted data
 *
 * These tools allow the oracle (LLM) to access data that was offloaded
 * to the vault during MCP tool calls. Two strategies are provided:
 *
 * 1. query_vaulted_data - Execute SQL on vaulted data (token efficient)
 * 2. retrieve_vaulted_data - Get full data (token heavy, use sparingly)
 *
 * @param queryService The DataVaultQueryService instance
 * @param userDid The user's DID for ownership validation
 * @returns Array of LangChain tools
 */
export function createOracleRetrievalTools(
  queryService: DataVaultQueryService,
  userDid: string,
): DynamicStructuredTool[] {
  logger.log(`Creating oracle retrieval tools for user: ${userDid.slice(-8)}`);

  /**
   * Tool 1: SQL Query (PREFERRED - token efficient)
   *
   * Executes SQL queries on vaulted data without loading
   * the full dataset into the LLM context. Perfect for:
   * - Aggregations (AVG, SUM, COUNT, etc.)
   * - Filtering (WHERE clauses)
   * - Specific lookups
   * - Data transformations
   */
  const queryTool = new DynamicStructuredTool({
    name: 'query_vaulted_data',
    description: `Execute SQL query on vaulted data. Returns only the query results, not the full dataset.

**PREFERRED METHOD** - Use this for most data analysis tasks as it minimizes token usage.

**When to use:**
- Aggregations: AVG, SUM, COUNT, MIN, MAX, GROUP BY
- Filtering: WHERE clauses to get specific records
- Counting: How many records match a condition
- Lookups: Find specific records by value
- Sorting: ORDER BY with LIMIT

**SQL Syntax:**
- Use {table} as the table name placeholder
- Standard SQL supported (DuckDB dialect)
- Results limited to 10,000 rows maximum

**Examples:**
- "What's the average amount?" → SELECT AVG(amount) FROM {table}
- "Count by category" → SELECT category, COUNT(*) FROM {table} GROUP BY category
- "Top 10 by value" → SELECT * FROM {table} ORDER BY value DESC LIMIT 10
- "Filter by date" → SELECT * FROM {table} WHERE date > '2024-01-01'

**Parameters:**
- handleId: The vault handle ID from _dataOffloaded metadata
- sql: Your SQL query with {table} as table placeholder
- accessToken: The fetchToken from the metadata`,
    schema: z.object({
      handleId: z.string().describe('The vault handle ID (from handleId in metadata)'),
      sql: z.string().describe('SQL query to execute. Use {table} as the table name.'),
      accessToken: z.string().describe('The access token (from fetchToken in metadata)'),
    }),
    func: async (args) => {
      logger.log(`query_vaulted_data: handle=${args.handleId}`);

      try {
        const result = await queryService.executeQuery({
          handleId: args.handleId,
          sql: args.sql,
          userDid,
          accessToken: args.accessToken,
        });

        // Return a concise result for LLM context
        return JSON.stringify({
          success: true,
          rows: result.rows,
          rowCount: result.rowCount,
          columns: result.columns,
          executionTimeMs: result.executionTimeMs,
          truncated: result.truncated,
          _note: result.truncated
            ? `Results truncated to ${result.rowCount} rows. Add LIMIT or more specific WHERE clause for full results.`
            : undefined,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Query failed';
        const isDataNotFound =
          errorMessage.includes('not found') ||
          errorMessage.includes('expired') ||
          errorMessage.includes('access denied');

        logger.error(`Query failed:`, error);

        if (isDataNotFound) {
          return JSON.stringify({
            success: false,
            error: 'Data not found or expired',
            errorType: 'DATA_NOT_FOUND',
            handleId: args.handleId,
            _recovery: `The vault handle "${args.handleId}" has expired or does not exist.

DO NOT retry with the same handle - it will fail again.

To get the data, you must call the ORIGINAL MCP tool that produced this data.
Look at the conversation history to find which MCP tool was called (e.g., ecs_getByMcpId, etc.) and call it again.
This will store fresh data in the vault with a NEW handle.`,
          });
        }

        // SQL syntax or execution error
        return JSON.stringify({
          success: false,
          error: errorMessage,
          errorType: 'QUERY_ERROR',
          _hint: 'Check SQL syntax. Use {table} as the table placeholder.',
        });
      }
    },
  });

  /**
   * Tool 2: Full Retrieval (USE SPARINGLY - token heavy)
   *
   * Retrieves the complete dataset from the vault. This returns
   * all data to the LLM context, consuming many tokens.
   *
   * Only use when SQL queries aren't sufficient, such as:
   * - Complex pattern matching across records
   * - Iterative analysis that can't be expressed in SQL
   * - When you truly need to see all the data
   */
  const retrieveTool = new DynamicStructuredTool({
    name: 'retrieve_vaulted_data',
    description: `Retrieve the FULL dataset from the vault.

**USE SPARINGLY** - This loads all data into context, consuming many tokens.

**Token Cost Warning:**
- 100 rows ≈ 400-800 tokens
- 500 rows ≈ 2,000-4,000 tokens
- 1000 rows ≈ 4,000-8,000 tokens

**When to use:**
- Complex pattern analysis that can't be expressed in SQL
- When you need to iterate over records with complex logic
- Statistical analysis requiring full data access
- When query_vaulted_data returns insufficient results

**When NOT to use:**
- Simple aggregations (use query_vaulted_data with AVG, SUM, etc.)
- Counting records (use query_vaulted_data with COUNT)
- Filtering data (use query_vaulted_data with WHERE)
- Getting top/bottom N (use query_vaulted_data with ORDER BY LIMIT)

**Always prefer query_vaulted_data first.** Only use this if SQL isn't sufficient.

**Parameters:**
- handleId: The vault handle ID from _dataOffloaded metadata
- accessToken: The fetchToken from the metadata
- limit: Optional - max rows to return (recommended for large datasets)`,
    schema: z.object({
      handleId: z.string().describe('The vault handle ID (from handleId in metadata)'),
      accessToken: z.string().describe('The access token (from fetchToken in metadata)'),
      limit: z
        .number()
        .optional()
        .describe('Maximum rows to return. Use this for safety with large datasets.'),
    }),
    func: async (args) => {
      logger.log(`retrieve_vaulted_data: handle=${args.handleId} limit=${args.limit ?? 'none'}`);

      try {
        const result = await queryService.retrieveFullData({
          handleId: args.handleId,
          userDid,
          accessToken: args.accessToken,
          limit: args.limit,
        });

        return JSON.stringify({
          success: true,
          data: result.data,
          rowCount: result.rowCount,
          sizeBytes: result.sizeBytes,
          estimatedTokens: result.estimatedTokens,
          limitApplied: result.limitApplied,
          _warning:
            result.estimatedTokens > 2000
              ? `Large dataset: ~${result.estimatedTokens} tokens. Consider using query_vaulted_data with SQL for aggregations/filtering.`
              : undefined,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Retrieval failed';
        const isDataNotFound =
          errorMessage.includes('not found') ||
          errorMessage.includes('expired') ||
          errorMessage.includes('access denied');

        logger.error(`Retrieval failed:`, error);

        if (isDataNotFound) {
          return JSON.stringify({
            success: false,
            error: 'Data not found or expired',
            errorType: 'DATA_NOT_FOUND',
            handleId: args.handleId,
            _recovery: `The vault handle "${args.handleId}" has expired or does not exist.

DO NOT retry with the same handle - it will fail again.

To get the data, you must call the ORIGINAL MCP tool that produced this data.
Look at the conversation history to find which MCP tool was called (e.g., ecs_getByMcpId, etc.) and call it again.
This will store fresh data in the vault with a NEW handle.`,
          });
        }

        return JSON.stringify({
          success: false,
          error: errorMessage,
          errorType: 'RETRIEVAL_ERROR',
        });
      }
    },
  });

  return [queryTool, retrieveTool];
}
