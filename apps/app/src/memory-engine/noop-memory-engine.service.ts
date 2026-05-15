import { MemoryEngineService } from '@ixo/common';

/**
 * No-op replacement for the upstream MemoryEngineService. Both public methods
 * return immediately without hitting the remote memory engine, so session
 * creation and per-session history sync no longer block on a multi-second
 * HTTP round trip (the call was contributing ~3s of event-loop pressure on
 * every new session and on every message that triggered history processing).
 *
 * We subclass the real service and override the two methods that callers in
 * the app reach: `gatherUserContext` (used by SessionManagerService when
 * creating a session) and `processConversationHistory` (used by
 * SessionHistoryProcessor). All other inherited helpers stay intact so any
 * future caller that reads e.g. the URL still compiles.
 */
export class NoopMemoryEngineService extends MemoryEngineService {
  constructor() {
    super('http://noop.invalid');
  }

  override async gatherUserContext(): Promise<Record<string, never>> {
    return {};
  }

  override async processConversationHistory(): Promise<{ success: boolean }> {
    return { success: true };
  }
}
