import { ClientConfig, MultiServerMCPClient } from '@langchain/mcp-adapters';
import { Logger } from '@nestjs/common';
import { type StructuredTool } from 'langchain';

// Static allowlist for MCP access (temp solution)
const ALLOWED_MCP_DIDS: string[] = [
  // Add allowed DIDs here
  'did:ixo:ixo1tfcltwvk35s6jdsxs09u5mqkrx5u0n3vu2vqgy', // mike
  'did:ixo:ixo1zem4acd0tudd0p8jf4x3nunt4h86sxnxsf0z0s', // mike
  'did:ixo:ixo1nc6sygtv4jzdsssg2xjzmuszk9uhe2jnf970sd', // mike
];

const mcpConfig: ClientConfig = {
  useStandardContentBlocks: true,
  prefixToolNameWithServerName: true,
  mcpServers: {
    ecs: {
      type: 'http',
      transport: 'http',
      url: 'http://localhost:8083/mcp',
      headers: {
        Authorization: 'Bearer qnqzuQ48knggcYphzPW&CLPr68zHJ^52',
      },
    },
  },
};

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
 * Creates and retrieves tools from the MCP client
 * @param userDid - User DID to check against allowlist
 * @returns Array of structured tools ready for agent integration
 */
export const createMCPClientAndGetTools = async (
  userDid: string,
): Promise<StructuredTool[]> => {
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
    return tools;
  } catch (error) {
    Logger.error('Failed to get MCP tools:', error);
    return [];
    // throw error;
  }
};
