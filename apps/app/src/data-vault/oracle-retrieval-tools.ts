import { DynamicStructuredTool } from 'langchain';
import { z } from 'zod';
import { DataVaultQueryService } from './query.service';
import { Logger } from '@nestjs/common';

const logger = new Logger('OracleRetrievalTools');

// Hard cap on the JSON payload sent back to the LLM. Anything bigger and we
// refuse instead of flooding the conversation history — bloated tool results
// blow the model's context window and produce empty completions downstream.
// 100 KB ≈ 25K tokens; ample for analytics aggregations and small samples.
const MAX_RESULT_BYTES = 100_000;

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
    description: `Execute SQL on vaulted data to derive **analytics insights** — counts, aggregates, breakdowns, lookups, top-N. Results return to YOU as JSON.

**This tool is for INSIGHTS, not BULK RETRIEVAL.** Pulling many wide rows back into your context will bloat the conversation, exceed the model's context window on the next turn, and silently break the agent. If the user wants to *see* the data as a table/chart, use an AG-UI tool (e.g. \`create_data_table\`) with the vault \`handleId\` + \`fetchToken\` instead — the data is rendered client-side and never enters your context.

**Use for:**
- Aggregations: AVG, SUM, COUNT, MIN, MAX, GROUP BY
- Filtering counts: how many records match a condition
- Top-N lookups (small N) and specific record lookups
- Group-by breakdowns

**SQL syntax:**
- Use \`{table}\` as the table-name placeholder
- DuckDB dialect
- Hard cap: 2000 rows max per query (a LIMIT 2000 is auto-appended if you omit one). Results that exceed the byte budget will be REJECTED with \`errorType: "RESULT_TOO_LARGE"\` — narrow your projection (fewer columns) or aggregate.

**Examples (good — small, aggregated):**
- \`SELECT COUNT(*) FROM {table} WHERE country = 'ZM'\`
- \`SELECT country, COUNT(*) FROM {table} GROUP BY country ORDER BY 2 DESC\`
- \`SELECT AVG(amount), SUM(amount) FROM {table}\`
- \`SELECT customer_id, full_name FROM {table} WHERE given_name LIKE 'J%' LIMIT 20\`

**Anti-examples (bad — bulk retrieval, will be rejected or break the agent):**
- \`SELECT * FROM {table}\` — too wide, will be rejected
- \`SELECT customer_id, full_name, given_name, family_name, country, ... FROM {table} WHERE cx_subs_active > 0\` — many columns × many rows = context overflow. Aggregate, or use an AG-UI table.

**Parameters:**
- handleId: vault handle ID from \`_dataOffloaded\` metadata
- sql: SQL with \`{table}\` placeholder
- accessToken: \`fetchToken\` from the metadata`,
    schema: z.object({
      handleId: z
        .string()
        .describe('The vault handle ID (from handleId in metadata)'),
      sql: z
        .string()
        .describe('SQL query to execute. Use {table} as the table name.'),
      accessToken: z
        .string()
        .describe('The access token (from fetchToken in metadata)'),
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

        const payload = {
          success: true,
          rows: result.rows,
          rowCount: result.rowCount,
          columns: result.columns,
          executionTimeMs: result.executionTimeMs,
          truncated: result.truncated,
          _note: result.truncated
            ? `Results truncated to ${result.rowCount} rows. Add LIMIT or more specific WHERE clause for full results.`
            : undefined,
        };

        const serialized = JSON.stringify(payload);

        // Hard byte-budget guard: refuse oversized payloads instead of letting
        // the agent splice megabytes of rows into conversation history. The
        // LLM gets a clear, actionable error and can re-issue a tighter query.
        if (serialized.length > MAX_RESULT_BYTES) {
          const sizeKb = Math.round(serialized.length / 1024);
          logger.warn(
            `query_vaulted_data: rejecting oversized result ${sizeKb} KB (${result.rowCount} rows × ${result.columns.length} cols)`,
          );
          return JSON.stringify({
            success: false,
            error: `Result too large: ${sizeKb} KB across ${result.rowCount} rows × ${result.columns.length} columns. Returning this would overflow the model's context window.`,
            errorType: 'RESULT_TOO_LARGE',
            rowCount: result.rowCount,
            columnCount: result.columns.length,
            byteSize: serialized.length,
            byteLimit: MAX_RESULT_BYTES,
            _recovery: `Reissue the query in one of these ways:
1. Aggregate instead of returning raw rows — COUNT(*), SUM, AVG, GROUP BY.
2. Project fewer columns — only the ones you actually need to answer the question.
3. Add a tight WHERE clause and a small LIMIT (e.g. LIMIT 50).
4. If the user wants to SEE the data as a table, do NOT call this tool — call the AG-UI \`create_data_table\` action with the vault \`handleId\` + \`fetchToken\` so the rows render client-side without entering your context.`,
          });
        }

        return serialized;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Query failed';
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
      handleId: z
        .string()
        .describe('The vault handle ID (from handleId in metadata)'),
      accessToken: z
        .string()
        .describe('The access token (from fetchToken in metadata)'),
      limit: z
        .number()
        .optional()
        .describe(
          'Maximum rows to return. Use this for safety with large datasets.',
        ),
    }),
    func: async (args) => {
      logger.log(
        `retrieve_vaulted_data: handle=${args.handleId} limit=${args.limit ?? 'none'}`,
      );

      try {
        const result = await queryService.retrieveFullData({
          handleId: args.handleId,
          userDid,
          accessToken: args.accessToken,
          limit: args.limit,
        });

        const payload = {
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
        };

        const serialized = JSON.stringify(payload);

        // Same byte-budget guard as query_vaulted_data — refuse before flooding
        // the conversation history with rows that will overflow on the next turn.
        if (serialized.length > MAX_RESULT_BYTES) {
          const sizeKb = Math.round(serialized.length / 1024);
          logger.warn(
            `retrieve_vaulted_data: rejecting oversized result ${sizeKb} KB (${result.rowCount} rows)`,
          );
          return JSON.stringify({
            success: false,
            error: `Result too large: ${sizeKb} KB across ${result.rowCount} rows. Returning this would overflow the model's context window.`,
            errorType: 'RESULT_TOO_LARGE',
            rowCount: result.rowCount,
            byteSize: serialized.length,
            byteLimit: MAX_RESULT_BYTES,
            _recovery: `This tool loads full rows into context — use it sparingly and with a small \`limit\`. Better options:
1. Use \`query_vaulted_data\` with SQL to aggregate or filter to a small slice.
2. Reissue this call with a smaller \`limit\` (e.g. 25–50).
3. If the user wants to SEE the data, call the AG-UI \`create_data_table\` action with the vault \`handleId\` + \`fetchToken\` — rendered client-side, no context cost.`,
          });
        }

        return serialized;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Retrieval failed';
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
