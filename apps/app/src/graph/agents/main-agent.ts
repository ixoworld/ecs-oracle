import { parserActionTool, parserBrowserTool } from '@ixo/common';
import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { OpenIdTokenProvider } from '@ixo/oracles-chain-client';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Logger } from '@nestjs/common';
import {
  createAgent,
  toolRetryMiddleware,
  type ReactAgent,
  type StructuredTool,
} from 'langchain';
import { getConfig, isRedisEnabled } from 'src/config';
import { type UcanService } from 'src/ucan/ucan.service';

import { createPageContextMiddleware } from '../middlewares/page-context-middleware';
import { createTokenLimiterMiddleware } from '../middlewares/token-limiter-middelware';
import { createToolValidationMiddleware } from '../middlewares/tool-validation-middleware';
import {
  AG_UI_TOOLS_DOCUMENTATION,
  AI_ASSISTANT_PROMPT,
  ECS_ORACLE_SKILL_DOCUMENTATION,
  ECS_ORACLE_SKILL_NOT_AUTHORIZED,
  SLACK_FORMATTING_CONSTRAINTS_CONTENT,
} from '../nodes/chat-node/prompt';
import { isEcsAuthorized } from '../utils/ecs-access';
import { type TMainAgentGraphState } from '../state';
import { contextSchema } from '../types';
import { createAguiAgent } from './agui-agent';
import { createApplySandboxOutputToBlockTool } from './editor/apply-sandbox-output-to-block';
import { createEditorAgent } from './editor/editor-agent';
import {
  logEditorSessionToMemory,
  type PageMemoryAuth,
} from './editor/page-memory';
import {
  EDITOR_MODE_PROMPTS,
  STANDALONE_EDITOR_PROMPTS,
} from './editor/prompts';
import { createStandaloneEditorTool } from './editor/standalone-editor-tool';
import { createPortalAgent } from './portal-agent';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool';

import { DynamicStructuredTool } from 'langchain';
import fs from 'node:fs';
import path from 'node:path';
import {
  type FileProcessingService,
  type SandboxUploadConfig,
} from 'src/messages/file-processing.service';
import {
  SecretsService,
  type SecretIndexEntry,
} from 'src/secrets/secrets.service';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import z from 'zod';
import oracleConfigRaw from '../../../oracle.config.json';
import { yieldToEventLoop } from '../../utils/event-loop';
import { timedCheckpointer } from '../../utils/timed-checkpointer';

/**
 * Browser tools the front-end may still register (in `lib/storage/browser-tools.ts`)
 * but which the oracle no longer exposes to the LLM. These IndexedDB-cache
 * lookup tools were left half-wired through several iterations of the data
 * pipeline; they're being parked until we redesign the FE-cache reuse path
 * around the new R2-presigned-URL flow. Filtering at this edge keeps the
 * agent from seeing them and avoids the timeout-retry loop the LLM falls
 * into when an unsupported tool sits in the prompt.
 */
const DISABLED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'list_local_datasets',
  'get_dataset_details',
  'query_local_dataset',
]);

// Normalize optional fields: convert empty strings to undefined so downstream
// truthiness checks (`if (oracleConfig.model)`) are unambiguous.
const oracleConfig = {
  ...oracleConfigRaw,
  model: oracleConfigRaw.model || undefined,
  prompt: {
    opening: oracleConfigRaw.prompt.opening || undefined,
    communicationStyle: oracleConfigRaw.prompt.communicationStyle || undefined,
    capabilities: oracleConfigRaw.prompt.capabilities || undefined,
  },
};
import { ChannelMemoryService } from '../../channel-memory/channel-memory.service';
import { getProviderChatModel } from '../llm-provider';
import { createMCPClient } from '../mcp';
import { createChannelMemoryTools } from '../nodes/tools-node/channel-memory-tools';
import { createFileProcessingTool } from '../nodes/tools-node/file-processing-tool';
import { createListRoomFilesTool } from '../nodes/tools-node/list-room-files-tool';
import {
  createListSkillsTool,
  createSearchSkillsTool,
} from '../nodes/tools-node/skills-tools';
import { createSetUserPreferencesTool } from '../nodes/tools-node/user-preferences-tool';
import {
  UserPreferencesService,
  type UserPreferences,
} from 'src/user-preferences/user-preferences.service';

function buildOracleContext(oc: typeof oracleConfig): string {
  const lines: string[] = [];
  if (oc.oracleName) lines.push(`**Name:** ${oc.oracleName}`);
  if (oc.orgName) lines.push(`**Organization:** ${oc.orgName}`);
  if (oc.description) lines.push(`**Purpose:** ${oc.description}`);
  if (oc.location) lines.push(`**Location:** ${oc.location}`);
  return lines.join('\n');
}

/**
 * Render the user's stored preferences as a markdown bullet list for injection
 * into the system prompt. Returns an empty string when no prefs are set so the
 * mustache `{{#USER_PREFERENCES_CONTEXT}}` block is omitted entirely.
 */
function formatUserPreferences(prefs?: UserPreferences): string {
  if (!prefs) return '';

  const lines: string[] = [];
  if (prefs.agentName)
    lines.push(`- **Preferred agent name:** ${prefs.agentName}`);
  if (prefs.language) lines.push(`- **Preferred language:** ${prefs.language}`);
  if (prefs.tone) lines.push(`- **Tone:** ${prefs.tone}`);
  if (prefs.formality) lines.push(`- **Formality:** ${prefs.formality}`);
  if (prefs.customInstructions)
    lines.push(`- **Custom instructions:** ${prefs.customInstructions}`);

  return lines.join('\n');
}

interface InvokeMainAgentParams {
  state: Partial<TMainAgentGraphState>;
  config: IRunnableConfigWithRequiredFields;
  /** Optional UCAN service for MCP tool authorization */
  ucanService?: UcanService;
  /** Optional file processing service for the process_file tool */
  fileProcessingService?: FileProcessingService;
  /** Optional model override — a provider model ID (e.g. from getModelForRole). When set, overrides the default 'main' model. */
  modelOverride?: string;
  /**
   * Accepted but ignored — `streamMessage`/`sendMessage` still pass this
   * for source compatibility, but the Task Manager sub-agent has been
   * removed from the agent path.
   */
  tasksService?: unknown;
}

const configService = getConfig();
const llm = getProviderChatModel('main', {});

/**
 * Mint a UCAN service invocation and return it as a header pair.
 *
 * Encapsulates the common pattern of:
 *   1. calling `ucanService.createServiceInvocation`,
 *   2. wrapping the resulting token in a single-key header object,
 *   3. degrading silently on null / thrown errors.
 *
 * Returns `{}` (empty header set) on null result or thrown error so the
 * caller can spread it unconditionally. When `bearer` is true, the token
 * is prefixed with `Bearer ` to form a valid `Authorization` header value.
 */
async function mintInvocationHeader(args: {
  ucanService: UcanService;
  serviceUrl: string;
  userDid: string;
  resource: 'ixo:sandbox' | 'ixo:skills';
  headerName: string;
  bearer?: boolean;
  successLogContext: string;
  failureLogContext: string;
}): Promise<Record<string, string>> {
  const {
    ucanService,
    serviceUrl,
    userDid,
    resource,
    headerName,
    bearer = false,
    successLogContext,
    failureLogContext,
  } = args;
  try {
    const invocation = await ucanService.createServiceInvocation(
      serviceUrl,
      userDid,
      resource,
    );
    if (invocation) {
      Logger.debug(successLogContext);
      return { [headerName]: bearer ? `Bearer ${invocation}` : invocation };
    }
    return {};
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    Logger.warn(`${failureLogContext}: ${detail}`);
    return {};
  }
}

const oracleMatrixBaseUrl = configService
  .getOrThrow('MATRIX_BASE_URL')
  .replace(/\/$/, '');

const oracleOpenIdTokenProvider = new OpenIdTokenProvider({
  matrixAccessToken: configService.getOrThrow(
    'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  ),
  homeServerUrl: oracleMatrixBaseUrl,
  matrixUserId: configService.getOrThrow('MATRIX_ORACLE_ADMIN_USER_ID'),
});

export const createMainAgent = async ({
  state,
  config,
  ucanService,
  fileProcessingService,
  modelOverride,
}: InvokeMainAgentParams):// eslint-disable-next-line @typescript-eslint/no-explicit-any
Promise<ReactAgent<any>> => {
  const msgFromMatrixRoom = Boolean(
    state.messages?.at(-1)?.additional_kwargs.msgFromMatrixRoom,
  );

  const { configurable } = config;
  const { matrix } = configurable?.configs ?? {};
  Logger.log(
    `[createMainAgent] homeServerName: ${configurable.configs?.matrix.homeServerName}`,
  );
  // Derive user's Matrix ID from DID + homeserver for page invitations
  const userDid = configurable?.configs?.user?.did;
  const homeServer = configurable?.configs?.matrix?.homeServerName;
  const userMatrixId =
    userDid && homeServer
      ? `@${userDid.replace(/:/g, '-')}:${homeServer}`
      : undefined;
  const oracleOpenIdToken = configurable.configs?.user.matrixOpenIdToken
    ? await oracleOpenIdTokenProvider.getToken()
    : undefined;

  // Build memory auth for page/block operation tracking
  const pageMemoryAuth: PageMemoryAuth | undefined =
    oracleOpenIdToken &&
    configurable.configs?.user.matrixOpenIdToken &&
    matrix?.roomId
      ? {
          oracleToken: oracleOpenIdToken,
          userToken: configurable.configs.user.matrixOpenIdToken,
          oracleHomeServer: oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
          userHomeServer: configurable.configs.matrix.homeServerName ?? '',
          chatRoomId: matrix.roomId,
        }
      : undefined;

  Logger.log(
    `[createMainAgent] PageMemory auth ${pageMemoryAuth ? 'available' : 'unavailable (missing tokens or roomId)'}`,
  );

  // Load secret index + user preferences in parallel (cheap — one state query each).
  // Both are wrapped so a failure in either never blocks oracle startup.
  const roomId = configurable.configs?.matrix.roomId;
  const [secretIndex, userPreferences] = await Promise.all<
    [Promise<SecretIndexEntry[]>, Promise<UserPreferences | undefined>]
  >([
    roomId
      ? SecretsService.getInstance()
          .getSecretIndex(roomId)
          .catch((err: unknown) => {
            Logger.warn(
              `[createMainAgent] Failed to load secret index: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
          })
      : Promise.resolve([]),
    roomId
      ? UserPreferencesService.getInstance()
          .get(roomId)
          .catch((err: unknown) => {
            Logger.warn(
              `[createMainAgent] Failed to load user preferences: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          })
      : Promise.resolve(undefined),
  ]);

  // Build base headers for sandbox MCP (auth only — secrets added lazily)
  // Try UCAN invocation first, fall back to Matrix OpenID tokens.
  //
  // `sandboxType: standard` routes every sandbox MCP call from this oracle
  // to the `SandboxStandard` Durable Object binding (instance_type:
  // standard-1, keepAlive: true) instead of the default `lite` (1/16 vCPU,
  // 5-min auto-sleep). Lite was throttling CPU-bound work in the
  // ecs-oracle skill — JSON.parse / gzip / DuckDB scan were running
  // ~10-20× slower than locally, which is most of the per-turn latency we
  // saw. ECS oracle traffic is always data-heavy (fetch.js + query.js),
  // so pinning the whole oracle to standard is the cheapest fix. If
  // future skills need lite (e.g. for cost reasons on cheap one-shot
  // work), we can extend the sandbox MCP to accept a per-call
  // `sandboxType` param.
  const matrixFallbackHeaders: Record<string, string> = {
    Authorization: `Bearer ${configurable.configs?.user.matrixOpenIdToken}`,
    'x-matrix-homeserver': configurable.configs?.matrix.homeServerName ?? '',
    'X-oracle-openid-token': oracleOpenIdToken ?? '',
    'x-oracle-homeserver': oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
    sandboxType: 'standard',
  };

  let sandboxHeaders: Record<string, string> = matrixFallbackHeaders;

  if (ucanService?.hasSigningKey() && configurable.configs?.user?.did) {
    // Mint sandbox + skills invocations in parallel — they're independent
    // and on a cold UCAN cache each is ~150-300 ms of sync crypto, so doing
    // them serially adds 300-600 ms to the request hot path. The per-
    // (user, service) cache inside createServiceInvocation makes warm
    // calls instant; the parallelism only helps on cold misses but costs
    // nothing on hits.
    //
    // SKILLS_CAPSULES_BASE_URL has a default in the env Zod schema, so
    // `configService.get(...)` is safe.
    const [sandboxAuthHeader, skillsHeader] = await Promise.all([
      mintInvocationHeader({
        ucanService,
        serviceUrl: configService.getOrThrow('SANDBOX_MCP_URL'),
        userDid: configurable.configs.user.did,
        resource: 'ixo:sandbox',
        headerName: 'Authorization',
        bearer: true,
        successLogContext: '[UCAN] Using UCAN invocation for sandbox auth',
        failureLogContext:
          '[UCAN] Failed to create sandbox invocation, falling back to Matrix auth',
      }),
      mintInvocationHeader({
        ucanService,
        serviceUrl:
          configService.get('SKILLS_CAPSULES_BASE_URL') ??
          'https://capsules.skills.ixo.earth',
        userDid: configurable.configs.user.did,
        resource: 'ixo:skills',
        headerName: 'X-Skills-Invocation',
        successLogContext:
          '[UCAN] Attached X-Skills-Invocation header for sandbox',
        failureLogContext:
          '[UCAN] Failed to create skills invocation, omitting X-Skills-Invocation header',
      }),
    ]);

    if (sandboxAuthHeader.Authorization) {
      // Keep `sandboxType` and any other non-auth headers from
      // matrixFallbackHeaders — swapping in the UCAN Authorization should
      // not drop the sandbox-tier routing header.
      sandboxHeaders = {
        sandboxType: matrixFallbackHeaders.sandboxType,
        ...sandboxAuthHeader,
        'X-Auth-Type': 'ucan',
      };
    }
    sandboxHeaders = { ...sandboxHeaders, ...skillsHeader };
  }

  // Create sandbox MCP with auth headers (for tool schema discovery)
  const hasSandboxAuth =
    (configurable.configs?.user.matrixOpenIdToken && oracleOpenIdToken) ||
    sandboxHeaders['X-Auth-Type'] === 'ucan';
  const sandboxMCP = hasSandboxAuth
    ? createMCPClient({
        mcpServers: {
          sandbox: {
            type: 'http',
            url: configService.getOrThrow('SANDBOX_MCP_URL'),
            transport: 'http',
            headers: sandboxHeaders,
          },
        },
        defaultToolTimeout: 180_000,
      })
    : undefined;

  // Build memory engine headers — UCAN first, Matrix fallback
  // Memory-engine wiring intentionally removed from the agent path.
  // The remote memory engine is not used by this oracle; keeping it out
  // saves: one UCAN invocation per request, one MCP client construction,
  // one sub-agent factory in the fan-out below, and several prompt
  // sections. The `memory-agent.ts` / `MemoryEngineService` code stays
  // on disk (other callers like SessionManager may still touch it) —
  // we just don't invoke any of it from here.

  // Build sandbox upload config for file processing (HTTP upload, no MCP needed)
  // Upload still uses Matrix OpenID tokens (UCAN upload support TODO)
  const sandboxUploadConfig: SandboxUploadConfig | undefined =
    configurable.configs?.user.matrixOpenIdToken && oracleOpenIdToken
      ? {
          sandboxMcpUrl: configService.getOrThrow('SANDBOX_MCP_URL'),
          userToken: configurable.configs.user.matrixOpenIdToken,
          oracleToken: oracleOpenIdToken,
          homeServerName: configurable.configs.matrix.homeServerName,
          oracleHomeServerUrl: oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
        }
      : undefined;

  Logger.log(`msgFromMatrixRoom: ${msgFromMatrixRoom}`);

  // Extract timezone and current time from config
  const userConfig = configurable?.configs?.user;
  const timezone = userConfig?.timezone;
  const currentTime = userConfig?.currentTime;

  // Format time context
  const timeContext = formatTimeContext(timezone, currentTime);

  if (!configurable?.configs?.user?.did) {
    throw new Error('User DID is required');
  }
  if (!configurable.thread_id) {
    throw new Error('Thread ID is required');
  }

  const agActionTools =
    state.agActions && state.agActions.length > 0
      ? state.agActions.map((action) => parserActionTool(action))
      : [];

  // ECS data access is gated by user DID. When authorized we describe the
  // ecs-oracle skill in the prompt AND inject ECS secrets as x-os-* headers
  // when calling sandbox_run. When not authorized neither happens — so even
  // an explicit "use ecs-oracle" request from the user fails fast with
  // MISSING_SECRET inside the skill.
  const ecsAuthorized = isEcsAuthorized(configurable.configs.user.did);

  // Build AG-UI sub-agent when actions are available
  const aguiAgentSpec =
    agActionTools.length > 0
      ? createAguiAgent({
          tools: agActionTools,
          userDid: configurable.configs.user.did,
          sessionId: configurable.thread_id,
        })
      : null;

  // Build operational mode + editor section via JS — cleaner than nested mustache conditionals
  const editorPrompts = state.editorRoomId
    ? EDITOR_MODE_PROMPTS
    : state.spaceId
      ? STANDALONE_EDITOR_PROMPTS
      : null;

  const operationalMode = editorPrompts
    ? editorPrompts.operationalMode
    : state.currentEntityDid
        ? [
            `**Entity Context Active**`,
            ``,
            `You are currently viewing an entity (DID: ${state.currentEntityDid}). Use:`,
            `- **Portal Agent** for navigation or UI actions (e.g., \`showEntity\`)`,
            ``,
            `**Important:** Pages (BlockNote documents) are NOT entities. For pages, use \`list_workspace_pages\` and \`call_editor_agent\`.`,
          ].join('\n')
        : [
            `**General Conversation Mode**`,
            ``,
            `### Tool Preferences`,
            `- **API calls / JSON data**: ALWAYS use the Sandbox (write a fetch/curl/requests script).`,
          ].join('\n');

  const editorSection = editorPrompts?.editorSection ?? '';

  // Track MCP/agent failures so the agent knows which capabilities are degraded
  const unavailableServices: string[] = [];

  /** Extract a value from a settled result, logging and tracking failures. */
  const settled = <T>(
    result: PromiseSettledResult<T>,
    fallback: T,
    name: string,
  ): T => {
    if (result.status === 'fulfilled') return result.value;
    Logger.error(
      `[createMainAgent] ${name} failed to initialize: ${String(result.reason)}`,
    );
    unavailableServices.push(name);
    return fallback;
  };

  // We just finished a sync-heavy prep block (UCAN delegation lookup,
  // tool schema parsing, etc). Yield once before launching the sub-agent
  // factory fan-out so the liveness probe can answer in this gap.
  await yieldToEventLoop();

  const [portalResult, sandboxResult] = await Promise.allSettled([
    createPortalAgent({
      tools:
        state.browserTools
          ?.filter((tool) => !DISABLED_BROWSER_TOOLS.has(tool.name))
          .map((tool) =>
            parserBrowserTool({
              description: tool.description,
              schema: tool.schema,
              toolName: tool.name,
            }),
          ) ?? [],
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    }),
    sandboxMCP?.getTools() ?? Promise.resolve([]),
  ]);

  const portalAgent = settled(portalResult, null, 'Portal Agent');
  const sandboxTools = settled(sandboxResult, [], 'Sandbox MCP');

  // System prompt — built after Promise.allSettled so per-result context
  // sections are only populated when their services actually loaded.
  // Yield once before the (synchronous, ~30-variable) mustache expansion
  // so the probe doesn't get blocked behind it.
  await yieldToEventLoop();
  const systemPrompt = await AI_ASSISTANT_PROMPT.format({
    APP_NAME:
      userPreferences?.agentName ??
      oracleConfig.oracleName ??
      configService.get('ORACLE_NAME') ??
      'Oracle',
    ORACLE_CONTEXT: buildOracleContext(oracleConfig),
    TIME_CONTEXT: timeContext,
    CURRENT_ENTITY_DID: state.currentEntityDid ?? '',
    OPERATIONAL_MODE: operationalMode,
    EDITOR_SECTION: editorSection,
    SLACK_FORMATTING_CONSTRAINTS:
      state.client === 'slack' ? SLACK_FORMATTING_CONSTRAINTS_CONTENT : '',
    USER_SECRETS_CONTEXT:
      secretIndex.length > 0
        ? secretIndex.map((s) => `- _USER_SECRET_${s.name}`).join('\n')
        : '',
    ECS_ORACLE_SKILL_DOCUMENTATION: ecsAuthorized
      ? ECS_ORACLE_SKILL_DOCUMENTATION
      : ECS_ORACLE_SKILL_NOT_AUTHORIZED,
    AG_UI_TOOLS_DOCUMENTATION:
      agActionTools.length > 0 ? AG_UI_TOOLS_DOCUMENTATION : '',
    USER_PREFERENCES_CONTEXT: formatUserPreferences(userPreferences),
  });

  // Wrap sandbox_run for lazy secret injection (both oracle and user secrets).
  // MCP adapters snapshot headers at construction time, so we create a new
  // MCP client with all secrets on first sandbox_run call.
  let enrichedRunTool: (typeof sandboxTools)[number] | null = null;
  let enrichedRunPromise: Promise<void> | null = null;

  const wrappedSandboxTools = sandboxTools.map((t) => {
    if (t.name !== 'sandbox_run') return t;

    return new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: t.schema,
      func: async (input) => {
        // Lazily create enriched MCP client on first sandbox_run call (promise-safe)
        if (!enrichedRunPromise) {
          enrichedRunPromise = (async () => {
            const enrichedHeaders = { ...sandboxHeaders };

            // Add oracle secrets as x-os-* headers
            const oracleSecretsStr = configService.get('ORACLE_SECRETS', '');
            if (oracleSecretsStr) {
              for (const pair of oracleSecretsStr.split(',')) {
                const eqIdx = pair.indexOf('=');
                if (eqIdx > 0) {
                  const key = pair.slice(0, eqIdx).trim();
                  const val = pair.slice(eqIdx + 1).trim();
                  if (key && val)
                    enrichedHeaders[`x-os-${key.toLowerCase()}`] = val;
                }
              }
            }

            // ECS data secrets — gated by the same DID whitelist used to
            // decide whether to show the ecs-oracle skill in the prompt.
            // Without these, fetch.mjs inside the sandbox exits with
            // MISSING_SECRET so non-authorized users can't reach ECS even
            // if they try to invoke the skill explicitly.
            if (ecsAuthorized) {
              const ecsMcpUrl = configService.get('ECS_MCP_URL');
              const ecsAuthToken = configService.get('ECS_MCP_AUTH_TOKEN');
              if (ecsMcpUrl) enrichedHeaders['x-os-ecs_mcp_url'] = ecsMcpUrl;
              if (ecsAuthToken)
                enrichedHeaders['x-os-ecs_mcp_auth_token'] = ecsAuthToken;
            }

            // Add user secrets as x-us-* headers
            if (secretIndex.length > 0 && roomId) {
              const values =
                await SecretsService.getInstance().loadSecretValues(
                  roomId,
                  secretIndex,
                );
              for (const [name, value] of Object.entries(values)) {
                enrichedHeaders[`x-us-${name.toLowerCase()}`] = value;
              }
            }

            const enrichedMCP = createMCPClient({
              mcpServers: {
                sandbox: {
                  type: 'http',
                  url: configService.getOrThrow('SANDBOX_MCP_URL'),
                  transport: 'http',
                  headers: enrichedHeaders,
                },
              },
              defaultToolTimeout: 180_000,
            });
            const enrichedTools = (await enrichedMCP?.getTools()) ?? [];
            enrichedRunTool =
              enrichedTools.find((et) => et.name === 'sandbox_run') ?? null;
          })();
        }

        await enrichedRunPromise;

        if (enrichedRunTool) {
          return enrichedRunTool.invoke(input);
        }
        // Fallback to original tool (without secrets)
        return t.invoke(input);
      },
    });
  });

  // Reuse the ixo:skills invocation already minted for sandbox forwarding.
  // Listing/search tools forward this directly to ai-skills so the user's
  // own private (published) skills surface alongside the public registry.
  // Undefined when UCAN is unavailable — the listing tools degrade to
  // public-only.
  const skillsUcan: string | undefined = sandboxHeaders['X-Skills-Invocation'];

  const listSkillsTool = createListSkillsTool({ skillsUcan });
  const searchSkillsTool = createSearchSkillsTool({ skillsUcan });

  // Conditionally create BlockNote (editor) agent tool if editorRoomId is provided
  let blockNoteAgentSpec:
    | Awaited<ReturnType<typeof createEditorAgent>>
    | undefined;
  if (state.editorRoomId) {
    Logger.log(`Editor room ID provided: ${state.editorRoomId}`);
    Logger.log('Initializing BlockNote tools...');

    try {
      blockNoteAgentSpec = await createEditorAgent({
        room: state.editorRoomId,
        mode: 'edit',
        userMatrixId,
        spaceId: state.spaceId,
        memoryAuth: pageMemoryAuth,
        userDid: configurable.configs.user.did,
        sessionId: configurable.thread_id,
      });
    } catch (error) {
      Logger.error(
        `[createMainAgent] Editor Agent failed to initialize: ${String(error)}`,
      );
      unavailableServices.push('Editor Agent');
    }
  }

  // Helper to inject time context into sub-agent system prompts
  const withTimeContext = (spec: AgentSpec): AgentSpec => ({
    ...spec,
    systemPrompt: `${spec.systemPrompt}\n\n## Current Time\n${timeContext}`,
  });

  // Create standalone editor tool when spaceId is present but no editor session.
  // Accepts a room_id per call, spinning up an ephemeral editor agent with full
  // BlockNote capabilities for that page.
  let standaloneEditorTool: StructuredTool | null = null;
  if (!state.editorRoomId && state.spaceId) {
    const userDid = configurable?.configs?.user?.did;
    const homeServer = configurable?.configs?.matrix?.homeServerName;
    const standaloneUserMatrixId =
      userDid && homeServer
        ? `@${userDid.replace(/:/g, '-')}:${homeServer}`
        : undefined;

    standaloneEditorTool = createStandaloneEditorTool({
      userMatrixId: standaloneUserMatrixId,
      spaceId: state.spaceId,
      memoryAuth: pageMemoryAuth,
      transformSpec: withTimeContext,
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    });

    Logger.log(`Created standalone editor tool with spaceId: ${state.spaceId}`);
  }

  // Create apply_sandbox_output_to_block tool when both sandbox and editor are available
  let applySandboxOutputToBlockTool: ReturnType<
    typeof createApplySandboxOutputToBlockTool
  > | null = null;
  if (state.editorRoomId) {
    const sandboxRunTool = wrappedSandboxTools.find(
      (t) => t.name === 'sandbox_run',
    );
    if (sandboxRunTool) {
      applySandboxOutputToBlockTool = createApplySandboxOutputToBlockTool({
        sandboxRunTool,
        editorRoomId: state.editorRoomId,
      });
      Logger.log('📦 Created apply_sandbox_output_to_block tool');
    }
  }

  const callPortalAgentTool = portalAgent
    ? createSubagentAsTool(withTimeContext(portalAgent))
    : null;
  const callAguiAgentTool = aguiAgentSpec
    ? createSubagentAsTool(withTimeContext(aguiAgentSpec), {
        forwardTools: agActionTools.map((t) => t.name),
      })
    : null;
  const callEditorAgentTool = blockNoteAgentSpec
    ? createSubagentAsTool(withTimeContext(blockNoteAgentSpec), {
        forwardTools: [
          'create_page',
          'update_page',
          'edit_block',
          'create_block',
        ],
        onComplete: pageMemoryAuth
          ? (messages, task) =>
              logEditorSessionToMemory(
                pageMemoryAuth,
                messages,
                state.editorRoomId!,
                task,
              )
          : undefined,
      })
    : null;
  let finalSystemPrompt = systemPrompt;
  if (unavailableServices.length > 0) {
    const serviceList = unavailableServices.map((s) => `- ${s}`).join('\n');
    finalSystemPrompt += `\n\n---\n\n## DEGRADED SERVICES\n\nThe following services failed to initialize and are temporarily unavailable. Do NOT attempt to use their tools — they will not work. Inform the user if they request functionality that depends on these services and suggest they try again later.\n\n${serviceList}\n`;
    Logger.warn(
      `[createMainAgent] ${unavailableServices.length} service(s) unavailable: ${unavailableServices.join(', ')}`,
    );
  }

  // Group-chat awareness: when MessagesService detects a group room it
  // attaches a pre-built context block to runnableConfig.configurable.
  // The roomId itself already lives on configurable.configs.matrix.roomId
  // (in `matrix?.roomId` above) — no need to duplicate.
  const configurableExt = configurable as Record<string, unknown>;
  const groupChatContext =
    typeof configurableExt.groupChatContext === 'string'
      ? configurableExt.groupChatContext
      : undefined;
  const isGroupRoom = Boolean(groupChatContext);

  if (groupChatContext) {
    finalSystemPrompt += `\n\n---\n\n## GROUP CHAT CONTEXT\n\n${groupChatContext}\n`;
  }

  const channelMemoryService = ChannelMemoryService.getInstance();
  const channelMemoryTools =
    isGroupRoom && matrix?.roomId && channelMemoryService
      ? createChannelMemoryTools({
          channelMemory: channelMemoryService,
          roomId: matrix.roomId,
          pinnedByDid: configurable.configs?.user?.did ?? '',
        })
      : [];

  // check db folder if not exists, create it
  const dbFolder = path.join(
    UserMatrixSqliteSyncService.checkpointsFolder,
    configurable?.configs?.user?.did,
  );
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }

  // Build middleware list conditionally
  const disableCredits = configService.get('DISABLE_CREDITS');

  const middleware = [
    createToolValidationMiddleware(),
    toolRetryMiddleware({ onFailure: (error) => error.message }),
    createPageContextMiddleware(),
  ];

  if (!disableCredits && isRedisEnabled()) {
    middleware.push(createTokenLimiterMiddleware());
  }

  // Priority: caller override → oracle.config model → default llm
  const effectiveModel = modelOverride
    ? getProviderChatModel('main', { model: modelOverride })
    : oracleConfig.model
      ? getProviderChatModel('main', { model: oracleConfig.model })
      : llm;

  const agent = createAgent({
    model: effectiveModel,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextSchema: contextSchema as any,
    tools: [
      ...wrappedSandboxTools,
      ...(callAguiAgentTool ? [callAguiAgentTool] : []),
      listSkillsTool,
      searchSkillsTool,
      ...(callPortalAgentTool ? [callPortalAgentTool] : []),
      ...(callEditorAgentTool ? [callEditorAgentTool] : []),
      ...(fileProcessingService
        ? [
            createFileProcessingTool(
              fileProcessingService,
              matrix?.roomId,
              sandboxUploadConfig,
            ),
          ]
        : []),
      ...(matrix?.roomId
        ? [
            createListRoomFilesTool(matrix.roomId),
            createSetUserPreferencesTool(matrix.roomId),
          ]
        : []),
      ...channelMemoryTools,
      ...(applySandboxOutputToBlockTool ? [applySandboxOutputToBlockTool] : []),
      ...(standaloneEditorTool ? [standaloneEditorTool] : []),
    ],
    middleware,
    stateSchema: z.object({
      editorRoomId: z.string().optional(),
    }),
    systemPrompt: finalSystemPrompt,
    checkpointer: timedCheckpointer(
      SqliteSaver.fromDatabase(
        await UserMatrixSqliteSyncService.getInstance().getUserDatabase(
          configurable?.configs?.user?.did,
        ),
      ),
      'main-agent',
    ),
    name: 'Companion Agent',
  });

  return agent;
};

// Helper function to format time context
const formatTimeContext = (
  timezone: string | undefined,
  currentTime: string | undefined,
): string => {
  if (!timezone && !currentTime) {
    return 'Not available.';
  }

  let context = '';

  if (currentTime) {
    context += `Current local time: ${currentTime}`;
  }

  if (timezone) {
    if (context) {
      context += `\nTimezone: ${timezone}`;
    } else {
      context += `Timezone: ${timezone}`;
    }
  }

  return context || 'Not available.';
};
