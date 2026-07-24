import type {
  CreateSessionInput,
  SessionStore,
} from "./session-store.js";
import {
  createSessionKey,
  type SessionKeyInput,
} from "./session-key.js";
import type { SessionEntry } from "./session-entry.js";

export class SessionResolver {
  public constructor(
    private readonly sessions: SessionStore,
  ) {}

  async resolve(input: SessionKeyInput): Promise<SessionEntry> {
    const key = createSessionKey(input);

    const existing = await this.sessions.getByKey(key);

    if (existing) {
      return existing;
    }

    const createInput: CreateSessionInput = {
      key,
      agentId: input.agentId,
    };

    return this.sessions.create(createInput);
  }
}
