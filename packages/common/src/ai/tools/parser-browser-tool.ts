import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { tool } from '@langchain/core/tools';
import { callBrowserTool } from './browser-tool-caller.js';
import { logActionToMatrix } from './log-action-to-matrix.js';

interface IParserBrowserToolParams {
  description: string;
  schema: Record<string, unknown>;
  toolName: string;
}

export function parserBrowserTool(params: IParserBrowserToolParams) {
  const { description, schema, toolName } = params;
  return tool(
    async (input, runnablesConfig) => {
      const {
        configurable: {
          thread_id,
          sessionId: explicitSessionId,
          requestId,
          configs,
        },
      } = runnablesConfig as IRunnableConfigWithRequiredFields & {
        configurable: { sessionId?: string };
      };
      // For sub-agent invocations (Portal Agent, Editor Agent, etc.)
      // `thread_id` is mangled with the sub-agent name/suffix for checkpoint
      // isolation; the real client sessionId is set explicitly on
      // `configurable.sessionId` in createSubagentAsTool. The WebSocket
      // gateway routes `browser_tool_call` events by sessionId — using the
      // mangled thread_id sends them to a room that doesn't exist, so the
      // browser never receives the call and the tool times out.
      const sessionId = explicitSessionId ?? thread_id;
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const result = await callBrowserTool({
        sessionId,
        toolName,
        args: input as Record<string, unknown>,
        toolCallId: `tc-${requestId}`,
      });

      if (configs?.matrix.roomId) {
        void logActionToMatrix(
          {
            name: toolName,
            args: input as Record<string, unknown>,
            result,
            success: true,
          },
          {
            roomId: configs.matrix.roomId,
            threadId: sessionId,
          },
        );
      }
      return result;
    },
    {
      name: toolName,
      description,
      schema,
      metadata: {
        browserTool: true,
      },
    },
  );
}
