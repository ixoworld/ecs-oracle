import {
  type ClientConfig,
  MultiServerMCPClient,
} from '@langchain/mcp-adapters';
import { Logger } from '@nestjs/common';
import { DynamicStructuredTool, type StructuredTool } from 'langchain';
import type { UcanService } from 'src/ucan/ucan.service';

/**
 * MCP wiring for the oracle.
 *
 * The oracle no longer talks to data MCP servers directly (e.g. the ECS
 * SupaMoto MCP). Anything that returns large payloads now lives in skills
 * executed inside the per-user sandbox container — see the `ecs-oracle`
 * skill and the `sandbox` MCP server for that path. Keeping the oracle out
 * of the data path entirely prevents the 30× heap-expansion problem the
 * MCP SDK + Zod validation produced for multi-MB responses.
 *
 * This module remains as a thin scaffold so:
 *   1. The codebase still has a single `createMCPClient` factory for
 *      whoever wires the sandbox MCP server later in `main-agent.ts`.
 *   2. The UCAN-wrapping helper stays available for any future MCP server
 *      that gets added with per-tool authorization requirements.
 */

/** Configuration knob: whether a given MCP server requires UCAN authorization. */
export interface MCPUCANServerConfig {
  requiresUcan: boolean;
}

/** Extended MCP config carrying optional per-server UCAN requirements. */
export interface MCPConfigWithUCAN extends ClientConfig {
  ucanConfig?: Record<string, MCPUCANServerConfig>;
}

/**
 * Parse `serverName__toolName` (the prefix matrix MCP adapters apply when
 * `prefixToolNameWithServerName` is true) back into its components.
 */
export function parseMCPToolName(toolName: string): {
  serverName: string;
  toolName: string;
} {
  const parts = toolName.split('__');
  if (parts.length >= 2) {
    return {
      serverName: parts[0],
      toolName: parts.slice(1).join('__'),
    };
  }
  return { serverName: 'unknown', toolName };
}

/** Per-request UCAN bundle the agent's runtime threads through state. */
export interface MCPUCANContext {
  invocations: Record<string, string>;
}

/**
 * Wrap one MCP tool with a UCAN validation gate. Tools whose server is not
 * marked `requiresUcan: true` pass through unchanged.
 */
export function wrapMCPToolWithUCAN(
  tool: StructuredTool,
  ucanService: UcanService,
  getContext: () => MCPUCANContext | undefined,
  serverConfig?: MCPUCANServerConfig,
): StructuredTool {
  if (!serverConfig?.requiresUcan) {
    return tool;
  }

  const { serverName, toolName } = parseMCPToolName(tool.name);

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    func: async (input: Record<string, unknown>, _runManager) => {
      const context = getContext();

      if (!context?.invocations) {
        return `Error: UCAN authorization required for ${tool.name}. No invocations provided in request.`;
      }

      const invocation = context.invocations[tool.name];
      if (!invocation) {
        return `Error: UCAN authorization required for ${tool.name}. No invocation found for this tool. Please provide a valid UCAN invocation.`;
      }

      const validationResult = await ucanService.validateMCPInvocation(
        serverName,
        toolName,
        invocation,
      );

      if (!validationResult.valid) {
        Logger.warn(
          `UCAN validation failed for ${tool.name}: ${validationResult.error}`,
        );
        return `Error: UCAN authorization failed for ${tool.name}: ${validationResult.error}`;
      }

      Logger.log(
        `✅ UCAN validated for ${tool.name} by ${validationResult.invokerDid}`,
      );

      try {
        return await tool.invoke(input);
      } catch (error) {
        Logger.error(`Error executing ${tool.name}:`, error);
        throw error;
      }
    },
  });
}

/**
 * Build an MCP client from a config block. Returns `undefined` for an empty
 * config so callers can short-circuit without try/catch.
 */
export const createMCPClient = (
  config: ClientConfig,
): MultiServerMCPClient | undefined => {
  if (!config || Object.keys(config.mcpServers ?? {}).length === 0) {
    Logger.warn('Skipping MCP client creation with empty configuration');
    return undefined;
  }

  try {
    const client = new MultiServerMCPClient(config);
    Logger.log(
      `🔌 MCP client created with ${Object.keys(config.mcpServers).length} server(s): ${Object.keys(config.mcpServers).join(', ')}`,
    );
    return client;
  } catch (error) {
    Logger.error('Failed to create MCP client:', error);
    return undefined;
  }
};
