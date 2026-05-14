import { MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import z from 'zod';

/**
 * In-memory cache for room title lookups.
 *
 * Without this, every wrapModelCall hop re-issues a Matrix state-event GET
 * for the same room — and when the bot isn't a member (the common case
 * for editor rooms it doesn't own) every call burns ~350-400ms returning
 * M_FORBIDDEN. Over a 5-hop tool sequence that's ~2s of pure waste per
 * turn. Caching the resolved title (or the fact that we couldn't get one)
 * eliminates that overhead.
 *
 * TTLs are intentionally short — room names can change and the bot can be
 * invited/uninvited mid-session — but long enough to amortise a single
 * agent turn cleanly.
 */
const SUCCESS_TTL_MS = 60_000; // titles rarely change
const FAILURE_TTL_MS = 120_000; // not-in-room is usually persistent

const titleCache = new Map<string, { title: string | undefined; expiresAt: number }>();

function readCache(roomId: string): { title: string | undefined } | undefined {
  const hit = titleCache.get(roomId);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    titleCache.delete(roomId);
    return undefined;
  }
  return { title: hit.title };
}

function writeCache(roomId: string, title: string | undefined, ok: boolean): void {
  titleCache.set(roomId, {
    title,
    expiresAt: Date.now() + (ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  });
}

async function resolvePageTitle(roomId: string): Promise<string | undefined> {
  const cached = readCache(roomId);
  if (cached) return cached.title;

  const t0 = Date.now();
  try {
    const client = MatrixManager.getInstance().getClient();
    if (!client) return undefined; // no client → don't cache, transient
    const ev = await client.mxClient.getRoomStateEvent(
      roomId,
      'm.room.name',
      '',
    );
    const title = (ev as { name?: string })?.name ?? undefined;
    writeCache(roomId, title, true);
    Logger.log(
      `[debug] resolvePageTitle ok room=${roomId} duration=${Date.now() - t0}ms (cached for ${SUCCESS_TTL_MS / 1000}s)`,
      'PageContextMiddleware',
    );
    return title;
  } catch (err) {
    writeCache(roomId, undefined, false);
    Logger.warn(
      `[debug] resolvePageTitle failed room=${roomId} duration=${Date.now() - t0}ms err=${err instanceof Error ? err.message : String(err)} (cached as unresolved for ${FAILURE_TTL_MS / 1000}s)`,
      'PageContextMiddleware',
    );
    return undefined;
  }
}

function formatLabel(title: string | undefined, roomId: string): string {
  return title ? `"${title}" (${roomId})` : roomId;
}

export const createPageContextMiddleware = (): AgentMiddleware => {
  return createMiddleware({
    name: 'PageContextMiddleware',
    stateSchema: z.object({
      editorRoomId: z.string().optional(),
      _previousEditorRoomId: z.string().optional(),
    }),
    wrapModelCall: async (request, handler) => {
      const currentEditorRoomId = request.state.editorRoomId;
      Logger.log(
        `[PageContextMiddleware] wrapModelCall called, editorRoomId: ${currentEditorRoomId}`,
      );

      if (!currentEditorRoomId) {
        Logger.log('[PageContextMiddleware] No editorRoomId, passing through.');
        return handler(request);
      }

      Logger.log('[PageContextMiddleware] Resolving current page title...');
      const currentTitle = await resolvePageTitle(currentEditorRoomId);
      Logger.log(
        `[PageContextMiddleware] Current page title: ${currentTitle ?? '(none)'}`,
      );
      const currentLabel = formatLabel(currentTitle, currentEditorRoomId);

      const previousEditorRoomId = request.state._previousEditorRoomId;
      Logger.log(
        `[PageContextMiddleware] Previous editorRoomId: ${previousEditorRoomId ?? '(none)'}`,
      );
      let pageContext: string;

      if (
        previousEditorRoomId &&
        previousEditorRoomId !== currentEditorRoomId
      ) {
        Logger.log(
          `[PageContextMiddleware] Page switch detected: ${previousEditorRoomId} → ${currentEditorRoomId}`,
        );
        const previousTitle = await resolvePageTitle(previousEditorRoomId);
        Logger.log(
          `[PageContextMiddleware] Previous page title: ${previousTitle ?? '(none)'}`,
        );
        const previousLabel = formatLabel(previousTitle, previousEditorRoomId);

        pageContext =
          `\n\n## 📄 Active Page Context\n\n` +
          `The user has switched pages. Current page: ${currentLabel}. ` +
          `Previous page: ${previousLabel}. ` +
          `Previous page context in conversation history may be stale. ` +
          `Always favour the current active page. ` +
          `Before making any edits, use read_page to confirm the current page content ` +
          `and verify it matches what the user is asking you to work on. ` +
          `If the content differs from what was discussed, confirm with the user before editing.`;
      } else {
        Logger.log(
          '[PageContextMiddleware] No page switch. Injecting current page context.',
        );
        pageContext =
          `\n\n## 📄 Active Page Context\n\n` +
          `Current active page: ${currentLabel}. Always work with this page.`;
      }

      Logger.log(
        '[PageContextMiddleware] Appending page context to system message.',
      );
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(pageContext),
      });
    },
    afterModel: (state) => {
      if (
        state.editorRoomId &&
        state.editorRoomId !== state._previousEditorRoomId
      ) {
        Logger.log(
          `[PageContextMiddleware] Updating _previousEditorRoomId: ${state._previousEditorRoomId ?? '(none)'} → ${state.editorRoomId}`,
        );
        return { _previousEditorRoomId: state.editorRoomId };
      }
      return;
    },
  });
};
