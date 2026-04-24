import { Logger } from '@nestjs/common';
import { DynamicStructuredTool, type StructuredTool } from 'langchain';
import { z } from 'zod';
import { DataVaultService, type SemanticAnalysis } from './data-vault.service';
import { DataAnalysisService } from './data-analysis.service';
import { extractDataByPaths } from './extraction-utils';

const logger = new Logger('MCPToolWrapper');

/**
 * Context needed for MCP tool wrapping
 */
export interface MCPWrapperContext {
  /** User DID for data ownership */
  userDid: string;
  /** Session ID for data association */
  sessionId: string;
  /** DataVault service instance */
  dataVault: DataVaultService;
  /** Data analysis service for semantic understanding */
  dataAnalysis?: DataAnalysisService;
  /** User's natural language query (optional, for better context) */
  userQuery?: string;
}

/**
 * Wrap MCP tools to intercept large results and offload to DataVault
 *
 * This is transparent to the MCP server - we wrap the tool's invoke function
 * and check the result size. If it's too large, we store it and return metadata.
 *
 * @param tools - Original MCP tools from MultiServerMCPClient
 * @param context - Context with user info and DataVault service
 * @returns Wrapped tools that handle large data offloading
 */
export function wrapMCPToolsWithDataVault(
  tools: StructuredTool[],
  context: MCPWrapperContext,
): StructuredTool[] {
  return tools.map((tool) => createWrappedTool(tool, context));
}

/**
 * Create a wrapped version of a single MCP tool
 */
function createWrappedTool(
  originalTool: StructuredTool,
  context: MCPWrapperContext,
): StructuredTool {
  const { userDid, sessionId, dataVault, dataAnalysis, userQuery } = context;

  return new DynamicStructuredTool({
    name: originalTool.name,
    description: originalTool.description,
    schema: originalTool.schema as z.ZodObject<any>,
    func: async (input, runManager, config) => {
      logger.log(`MCP tool: ${originalTool.name}`);

      // Call original MCP tool
      const result = await originalTool.invoke(input, config);

      // Calculate response size
      const responseString =
        typeof result === 'string' ? result : JSON.stringify(result);
      const responseSizeKB = (
        Buffer.byteLength(responseString, 'utf8') / 1024
      ).toFixed(2);
      const responseTokensEstimate = Math.ceil(responseString.length / 4);

      logger.log(
        `Response: ${responseSizeKB}KB (~${responseTokensEstimate} tokens)`,
      );

      // Parse JSON if string
      let parsedResult =
        typeof result === 'string'
          ? (() => {
              try {
                return JSON.parse(result);
              } catch {
                return result;
              }
            })()
          : result;

      // Non-JSON strings return as-is
      if (typeof parsedResult === 'string') {
        return parsedResult;
      }

      // Unwrap LangChain ToolMessage wrapper if present
      // MCP tools return ToolMessage objects where actual data is in 'content' as a JSON string
      if (
        parsedResult &&
        typeof parsedResult === 'object' &&
        'lc_serializable' in parsedResult &&
        'content' in parsedResult
      ) {
        const content = parsedResult.content;

        if (typeof content === 'string') {
          try {
            parsedResult = JSON.parse(content);
          } catch {
            // Content is not JSON, use as-is
            parsedResult = { content };
          }
        } else if (typeof content === 'object' && content !== null) {
          // Content is already an object
          parsedResult = content;
        }
      }

      // Unwrap MCP CallToolResult envelope.
      // Tools that declare an outputSchema return their typed payload under
      // `structuredContent` alongside envelope fields like { type, text,
      // source_type }. The structured field IS the data we want to analyze
      // and vault — the rest is protocol metadata. Prefer it when present so
      // the sub-agent sees the real response shape (e.g. { customers: [...] })
      // instead of the wrapper shape ({ type, text, structuredContent: {...} }).
      if (
        parsedResult &&
        typeof parsedResult === 'object' &&
        'structuredContent' in parsedResult &&
        (parsedResult as Record<string, unknown>).structuredContent !== null &&
        typeof (parsedResult as Record<string, unknown>).structuredContent ===
          'object'
      ) {
        parsedResult = (parsedResult as Record<string, unknown>)
          .structuredContent;
      }

      // If no data analysis service, skip intelligent offloading
      if (!dataAnalysis) {
        logger.warn(
          `No DataAnalysisService - skipping offload for ${originalTool.name}`,
        );
        return typeof result === 'string'
          ? result
          : JSON.stringify(parsedResult);
      }

      // Analyze with sub-agent to get extraction paths and semantics
      const samples = dataAnalysis.createStrategicSamples(parsedResult);
      const basicMetadata = dataAnalysis.extractBasicMetadata(parsedResult);

      const analysisResult = await dataAnalysis.analyzeData({
        samples,
        context: {
          toolName: originalTool.name,
          toolArgs: input,
          userQuery,
        },
        metadata: basicMetadata,
      });

      logger.log(
        `Analysis: ${analysisResult.offloadRecommendation} - ${analysisResult.dataType} ` +
          `extractionPaths=${JSON.stringify(analysisResult.dataExtractionPaths)} ` +
          `preserveInlinePaths=${JSON.stringify(analysisResult.preserveInlinePaths)}`,
      );

      // If no offload needed, return original
      if (analysisResult.offloadRecommendation === 'keep_inline') {
        return typeof result === 'string'
          ? result
          : JSON.stringify(parsedResult);
      }

      // Extract data using paths from sub-agent
      const [extractedData, modifiedResponse] = extractDataByPaths(
        parsedResult,
        analysisResult.dataExtractionPaths,
        analysisResult.preserveInlinePaths,
      );

      // Store each extracted dataset in vault
      const vaultMetadata: Record<string, unknown> =
        typeof modifiedResponse === 'object' && modifiedResponse !== null
          ? { ...(modifiedResponse as Record<string, unknown>) }
          : {};

      let totalRowsOffloaded = 0;
      let totalDataSizeKB = 0;

      for (const [, data] of extractedData.entries()) {
        if (!Array.isArray(data)) continue;

        const dataSize = Buffer.byteLength(JSON.stringify(data), 'utf8') / 1024;
        totalDataSizeKB += dataSize;
        totalRowsOffloaded += data.length;

        const semanticAnalysis: SemanticAnalysis = {
          description: analysisResult.semanticDescription,
          dataType: analysisResult.dataType,
          suggestedVisualizations: analysisResult.visualizationSuggestions,
          visualizationRationale: analysisResult.visualizationRationale,
          qualityInsights: analysisResult.qualityInsights,
          enhancements: analysisResult.metadataEnhancements,
        };

        const { metadata } = await dataVault.store(
          data,
          userDid,
          sessionId,
          originalTool.name,
          {
            toolArgs: input,
            userQuery,
          },
          semanticAnalysis,
        );

        // Merge metadata into response
        Object.assign(vaultMetadata, metadata);
      }

      const metadataSize =
        Buffer.byteLength(JSON.stringify(vaultMetadata), 'utf8') / 1024;
      const tokenSavings = Math.ceil(
        (parseFloat(responseSizeKB) - metadataSize) * 4,
      );

      // Sub-agent said offload but extraction found no arrays — paths were wrong.
      // Surface this to the model so it can retry or tell the user, rather than
      // silently returning empty metadata or flooding context with raw data.
      if (totalRowsOffloaded === 0) {
        const topLevelKeys =
          parsedResult && typeof parsedResult === 'object'
            ? Object.keys(parsedResult as Record<string, unknown>)
            : [];

        // Record the failed attempt so the next analyzeData call for this tool
        // gets a retry hint in the sub-agent's system prompt. The sub-agent is
        // otherwise deterministic — without a hint it re-returns the same bad
        // paths on every retry.
        if (dataAnalysis) {
          dataAnalysis.recordFailedAnalysis(
            originalTool.name,
            analysisResult.dataExtractionPaths,
            topLevelKeys,
          );
        }

        const diagnostic = {
          error: 'OFFLOAD_FAILED',
          message:
            'The data analysis sub-agent flagged this response for offload, but the extraction paths it returned did not resolve to any arrays. No data was stored in the vault.',
          attemptedExtractionPaths: analysisResult.dataExtractionPaths,
          attemptedPreservePaths: analysisResult.preserveInlinePaths,
          responseSizeKB: parseFloat(responseSizeKB),
          topLevelKeys,
          recovery:
            'Retry the same MCP tool call — the sub-agent has been given a hint about the correct paths and will try different ones on the next attempt. If it fails again, inform the user the response could not be processed.',
        };
        logger.error(
          `Offload failed: sub-agent paths ${JSON.stringify(analysisResult.dataExtractionPaths)} extracted 0 arrays from response with top-level keys ${JSON.stringify(topLevelKeys)}. Hint cached for next retry. Returning error to model.`,
        );
        return JSON.stringify(diagnostic);
      }

      // Successful offload — clear any prior failure hint for this tool so it
      // doesn't leak into a future call (e.g. if response shape drifts).
      if (dataAnalysis) {
        dataAnalysis.clearFailedAnalysis(originalTool.name);
      }

      logger.log(
        `Offloaded: ${totalRowsOffloaded} rows, ${totalDataSizeKB.toFixed(2)}KB data -> ${metadataSize.toFixed(2)}KB metadata (~${tokenSavings} tokens saved)`,
      );

      return JSON.stringify(vaultMetadata);
    },
  });
}

/**
 * Factory function to create MCP tool wrapper for a specific request context
 *
 * Use this in the main agent creation to wrap MCP tools per-request:
 *
 * ```typescript
 * const mcpTools = await createMCPClientAndGetTools(userDid);
 * const wrappedTools = wrapMCPToolsWithDataVault(mcpTools, {
 *   userDid,
 *   sessionId,
 *   dataVault: dataVaultService,
 *   dataAnalysis: dataAnalysisService,
 *   userQuery: 'optional user query for context',
 * });
 * ```
 */
export function createMCPToolWrapper(
  dataVault: DataVaultService,
  dataAnalysis: DataAnalysisService,
) {
  return (
    tools: StructuredTool[],
    userDid: string,
    sessionId: string,
    userQuery?: string,
  ): StructuredTool[] => {
    return wrapMCPToolsWithDataVault(tools, {
      userDid,
      sessionId,
      dataVault,
      dataAnalysis,
      userQuery,
    });
  };
}
