import { ClientConfig, MultiServerMCPClient } from '@langchain/mcp-adapters';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamicStructuredTool, type StructuredTool } from 'langchain';
import { ENV } from 'src/config';
import {
  DataVaultService,
  DataAnalysisService,
  wrapMCPToolsWithDataVault,
} from 'src/data-vault';
import { UcanService } from 'src/ucan/ucan.service';

const configService = new ConfigService<ENV>();

// Static allowlist for MCP access (temp solution)
const ALLOWED_MCP_DIDS: string[] = [
  'did:ixo:ixo1tfcltwvk35s6jdsxs09u5mqkrx5u0n3vu2vqgy', // mike
  'did:ixo:ixo1zem4acd0tudd0p8jf4x3nunt4h86sxnxsf0z0s', // mike
  'did:ixo:ixo1nc6sygtv4jzdsssg2xjzmuszk9uhe2jnf970sd', // mike
  'did:ixo:ixo1yxsut3tguvc65ud55zh3mgeveu06e0m6t5ulsf', // mike
  'did:ixo:ixo12am7v5xgjh72c7xujreyvtncqwue3w0v6ud3r4', // mike (alice)
  'did:ixo:ixo1ujxelhkaf0hnuhm0fhdsy6c3fy5rdwtk4nhnr6', // Graeme Test
  'did:ixo:ixo1v8ewsaavpavc9r44n6x6efknhscz56fp5k7a9m', // Graeme Main
  'did:ixo:ixo1qnh30usjtw2dujxphy805x2af6fhn5zmfhy2v9', // Graeme
  'did:x:zQ3shNGDBopWqD2byBcyo5dHeS5ggKE3bJyqRFKUfWLGPq2J4', // Graeme Main
  'did:ixo:ixo1aqrxzvwdw7wqh27jafc60j5ny9gyjcuewrvfp5', // Alwyn Test
  'did:ixo:ixo1aqrxzvwdw7wqh27jafc60j5ny9gyjcuewrvfp5', // Alwyn Main
  'did:ixo:ixo1hldfmx3h7hujfgty0mmykmvmh6cj8d8ptalfun', // Alwyn
  'did:ixo:ixo1latzweagqawv6cr3pdlkuvzetll35rlyfzd7nr', // Bupe Test
  'did:ixo:ixo16045372qxdvtyrh9at8tsm7zfskxqey8lw6nmg', // Bupe Test
  'did:x:zQ3shqitrJkJshfb6XSGLyALr3snt8XyAaDUEf1WEaHX8qqcW', // Bupe Main
  'did:ixo:ixo1zhjm7letn3f64jql7mewatn679zervxngy8acg', // Joshua Test
  'did:ixo:ixo1wrgdf0y9y6pz0vmz9vxk43l7dq7qu4xeel8hkz', // Annie Test
  'did:ixo:ixo1wrgdf0y9y6pz0vmz9vxk43l7dq7qu4xeel8hkz', // Joshua Test
  'did:ixo:ixo1vuv0sqv3dnwsc60g04pmwtn9xt2f0jvjjjncdu', // Loveness Test
  'did:ixo:ixo1u9ufzd4adw9xc0cymn53jas3zlxf4q6nxvy0e9', // Mike local
  'did:ixo:ixo1d82np5420yfa2nqwczgqkukgves49alv3v5uag', // Alwyn
  'did:ixo:ixo1m30l6lnw2nxuhhluwq7r0xw39l4mwy98xcpc96', // Joshua
  'did:ixo:ixo1ym5fc0m0gnggh0zde69qpmd9fnlxk75zrulj6c', // Annie
  'did:ixo:ixo1hcw9z35r5x2vjvpt57q865lt0qwqtedh79rlj0', // Bupe
  'did:ixo:ixo1tndv5ev5f2wyak0wdaxqfgjay3vg3jegfq0lcn', // Mosho
  'did:ixo:ixo139le0z4tum5wauac9xs4jj39zulf8umqyx60xv', // Evans Kalunga
  'did:ixo:ixo1hpe7t47zwz4p4a8s6dsuqhz702h4ar28qs3hc4', // Josephine Chime
  'did:ixo:ixo1n3jplcy9htchsv67ll92a426kxchqd56yu3z0f', // Cherister Choongo
  'did:ixo:ixo15ej8r2gd6a0x95z74ys0zkha9uqzg5kxnpemzy', // Christine Hill
  'did:ixo:ixo1erj3wzva95stz8reht7rqsma2ka8lanepelw2q', // Mattias Ohlson
  'did:ixo:ixo1rpm9fz3vkcdlnagchawjytzkjjcqlmwamz8vnf', // Towela Nyrienda
  'did:ixo:ixo1xatjpmm2kw4ujfyqzhucrmgp8prxu6au6mvhqr', // Marion Peterson
  'did:ixo:ixo19yr5c894mnhtnr2dm676y04j58p9jupk2nfnu3', // George Kalipenta
  'did:ixo:ixo1079guw4qpz8ymcfp6vcunf8gzxu5u3clggdc8e', // Chipo Bukowa
  'did:ixo:ixo1gxshyw8lcz8wvu2s5waq0plqcu5ftu2sfhwag4', // Edina Kayewa
  'did:ixo:ixo1sv72qcpzz7hjn9cf654vrzyvd983hz6tjagh0w', // Mercy Mbozi
  'did:ixo:ixo18fsl6l2fnw2gtady92nkpa975aqstdmgjgusfk', // Maclaud Nchimunya
  'did:ixo:ixo1dy2xhvvgwgslnvpf7dwevlzd3ug2ya08xezvc9', // Talopa Zulu
  'did:ixo:ixo1ghqgl9qdd3rydpwp5chgras3hz8q6qkhryl93x', // Chella Kamina
  'did:ixo:ixo1pjshp5vr6es5pagwyp97nrhh6ax2jepnemken0', // Harrison Teteka
  'did:ixo:ixo1paf4a2c6kz9ndmhv5lv6hw4wrkxhrvehqwuyn3', // Nancy Katongo
  'did:ixo:ixo1g39e9ehxtzqr3au6lqdlvawfyxcsgzy8flxamh', // Thandiwe Lungu
  'did:ixo:ixo19el3sd7cyjzjap4scsg4x9f0fwdctp5vecjcxu', // Mumba Chabwe
  'did:ixo:ixo1km8c4fpuh8zz6v53cpfcqllyeenyy2yawaxfsy', // Samuel Mulala
  'did:ixo:ixo1cc0nqnnatxwqnwamz9pxhy754yklxvxsvm6vmh', // Chikondi Nanyangwe
  'did:ixo:ixo1r06rh8z68geq9pdwrnts39gyk5sptppfne0tef', // Ebba Perbeck
  'did:ixo:ixo1ay6upt9459drkd2x7l3mpvedc0n9tqefywqhy3', // Duncan Phiri
  'did:ixo:ixo16ugu3hsfnuk80jvazgttlaw48h8se6teuz3v80', // Loveness Chibwe
];

/**
 * Configuration for UCAN-protected MCP servers
 * Map of server name to whether it requires UCAN authorization
 */
export interface MCPUCANServerConfig {
  /** Whether this MCP server requires UCAN authorization */
  requiresUcan: boolean;
}

/**
 * Extended MCP config with UCAN requirements
 */
export interface MCPConfigWithUCAN extends ClientConfig {
  /** UCAN requirements per MCP server */
  ucanConfig?: Record<string, MCPUCANServerConfig>;
}

const mcpConfig: MCPConfigWithUCAN = {
  useStandardContentBlocks: true,
  prefixToolNameWithServerName: true,
  mcpServers: {
    ecs: {
      type: 'http',
      transport: 'http',
      url: configService.getOrThrow('ECS_MCP_URL'),
      headers: {
        Authorization: `Bearer ${configService.getOrThrow('ECS_MCP_AUTH_TOKEN')}`,
      },
    },
  },
  // UCAN configuration per MCP server
  ucanConfig: {
    // Example: postgres requires UCAN authorization
    // postgres: { requiresUcan: true },
  },
};

/**
 * Parse MCP tool name to extract server and tool names
 * Tool names from MCP adapters are prefixed with server name: "serverName__toolName"
 *
 * @param toolName - The full tool name (e.g., "postgres__query")
 * @returns The parsed server and tool names
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
  // Fallback: treat as tool name only
  return {
    serverName: 'unknown',
    toolName: toolName,
  };
}

/**
 * Context for UCAN validation during tool execution
 */
export interface MCPUCANContext {
  /** Map of tool names to their serialized invocations */
  invocations: Record<string, string>;
}

/**
 * Wrap an MCP tool with UCAN validation
 *
 * @param tool - The original MCP tool
 * @param ucanService - The UCAN service for validation
 * @param getContext - Function to get the current UCAN context
 * @param serverConfig - UCAN configuration for this server
 * @returns A wrapped tool that validates UCAN before execution
 */
export function wrapMCPToolWithUCAN(
  tool: StructuredTool,
  ucanService: UcanService,
  getContext: () => MCPUCANContext | undefined,
  serverConfig?: MCPUCANServerConfig,
): StructuredTool {
  // If no UCAN required, return original tool
  if (!serverConfig?.requiresUcan) {
    return tool;
  }

  const { serverName, toolName } = parseMCPToolName(tool.name);

  // Create a wrapped tool that validates UCAN before execution
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    func: async (input: Record<string, unknown>, _runManager) => {
      // Get current UCAN context
      const context = getContext();

      if (!context?.invocations) {
        return `Error: UCAN authorization required for ${tool.name}. No invocations provided in request.`;
      }

      // Look up invocation for this tool
      const invocation = context.invocations[tool.name];
      if (!invocation) {
        return `Error: UCAN authorization required for ${tool.name}. No invocation found for this tool. Please provide a valid UCAN invocation.`;
      }

      // Validate the invocation
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

      // Execute the original tool
      try {
        // Call the original tool's invoke method
        // Note: We don't pass runManager directly as it has incompatible types
        const result = await tool.invoke(input);
        return result;
      } catch (error) {
        Logger.error(`Error executing ${tool.name}:`, error);
        throw error;
      }
    },
  });
}

/**
 * Creates an MCP client configured with multiple server connections
 * @param config - Configuration object with server definitions
 * @returns Configured MultiServerMCPClient instance
 */
export const createMCPClient = (
  config: ClientConfig,
): MultiServerMCPClient | undefined => {
  if (!config || Object.keys(config).length === 0) {
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
    throw error;
  }
};

/**
 * Context for MCP tool creation with data vault integration
 */
export interface MCPToolsContext {
  /** User DID for ownership and access control */
  userDid: string;
  /** Session ID for data association */
  sessionId: string;
  /** DataVault service for large data offloading */
  dataVault?: DataVaultService;
  /** Data analysis service for semantic understanding */
  dataAnalysis?: DataAnalysisService;
}

/**
 * Creates and retrieves tools from the MCP client
 * Optionally wraps tools with DataVault for large data handling
 *
 * @param context - Context with user info and optional DataVault service
 * @returns Array of structured tools ready for agent integration
 */
export const createMCPClientAndGetTools = async (
  context: MCPToolsContext,
): Promise<StructuredTool[]> => {
  const { userDid, sessionId, dataVault, dataAnalysis } = context;

  try {
    // Check allowlist first
    if (!ALLOWED_MCP_DIDS.includes(userDid)) {
      Logger.log(`MCP access denied for user: ${userDid}`);
      return [];
    }

    const hasServers = Object.keys(mcpConfig.mcpServers).length > 0;
    if (!hasServers) {
      return [];
    }
    const client = createMCPClient(mcpConfig);
    if (!client) {
      return [];
    }
    const tools = await client.getTools();
    Logger.log(`✅ Successfully loaded ${tools.length} MCP tool(s)`);

    // Wrap tools with DataVault if service is provided
    if (dataVault && tools.length > 0) {
      Logger.log(
        '🗄️ Wrapping MCP tools with DataVault for large data handling',
      );
      return wrapMCPToolsWithDataVault(tools, {
        userDid,
        sessionId,
        dataVault,
        dataAnalysis,
      });
    }

    return tools;
  } catch (error) {
    Logger.error('Failed to get MCP tools:', error);
    return [];
    // throw error;
  }
};

/**
 * Creates MCP tools wrapped with UCAN validation
 *
 * @param ucanService - The UCAN service for validation
 * @param getContext - Function to get the current UCAN context
 * @returns Array of UCAN-wrapped tools
 *
 * @example
 * ```typescript
 * // In main-agent.ts
 * const mcpTools = await createMCPClientAndGetToolsWithUCAN(
 *   ucanService,
 *   () => state.mcpUcanContext
 * );
 * ```
 */
export const createMCPClientAndGetToolsWithUCAN = async (
  ucanService: UcanService,
  getContext: () => MCPUCANContext | undefined,
  dataVaultContext?: MCPToolsContext,
): Promise<StructuredTool[]> => {
  try {
    // Check allowlist first if dataVaultContext provides userDid
    if (dataVaultContext?.userDid && !ALLOWED_MCP_DIDS.includes(dataVaultContext.userDid)) {
      Logger.log(`MCP access denied for user: ${dataVaultContext.userDid}`);
      return [];
    }

    const hasServers = Object.keys(mcpConfig.mcpServers).length > 0;
    if (!hasServers) {
      return [];
    }
    const client = createMCPClient(mcpConfig);
    if (!client) {
      return [];
    }
    const tools = await client.getTools();

    // Wrap each tool with UCAN validation if configured
    const ucanWrappedTools = tools.map((tool) => {
      const { serverName } = parseMCPToolName(tool.name);
      const serverConfig = mcpConfig.ucanConfig?.[serverName];

      if (serverConfig?.requiresUcan) {
        Logger.log(`🔒 Wrapping ${tool.name} with UCAN validation`);
        return wrapMCPToolWithUCAN(tool, ucanService, getContext, serverConfig);
      }

      return tool;
    });

    // Wrap tools with DataVault for large data offloading
    const { dataVault, dataAnalysis } = dataVaultContext ?? {};
    if (dataVault && ucanWrappedTools.length > 0) {
      Logger.log(
        '🗄️ Wrapping MCP tools with DataVault for large data handling',
      );
      const finalTools = wrapMCPToolsWithDataVault(ucanWrappedTools, {
        userDid: dataVaultContext?.userDid ?? '',
        sessionId: dataVaultContext?.sessionId ?? '',
        dataVault,
        dataAnalysis,
      });

      Logger.log(
        `✅ Successfully loaded ${finalTools.length} MCP tool(s) (${Object.keys(mcpConfig.ucanConfig ?? {}).length} with UCAN protection, DataVault enabled)`,
      );
      return finalTools;
    }

    Logger.log(
      `✅ Successfully loaded ${ucanWrappedTools.length} MCP tool(s) (${Object.keys(mcpConfig.ucanConfig ?? {}).length} with UCAN protection)`,
    );
    return ucanWrappedTools;
  } catch (error) {
    Logger.error('Failed to get MCP tools:', error);
    return [];
  }
};

/**
 * Get the list of MCP servers that require UCAN authorization
 * Useful for informing clients which tools need invocations
 */
export function getUCANProtectedServers(): string[] {
  return Object.entries(mcpConfig.ucanConfig ?? {})
    .filter(([_, config]) => config.requiresUcan)
    .map(([serverName]) => serverName);
}

// TODO: Add support for per-tool UCAN configuration (not just per-server)
// TODO: Add capability requirement inspection endpoint
// TODO: Add UCAN middleware for tool execution logging
