import { randomUUID } from "node:crypto";

import type { SessionEntry } from "./session-entry.js";
import type { CreateSessionInput, SessionStore } from "./session-store.js";

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  async create(input: CreateSessionInput): Promise<SessionEntry> {
    const now = new Date().toISOString();

    const session: SessionEntry = {
      key: input.key,
      sessionId: randomUUID(),
      agentId: input.agentId,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.key, session);

    return session;
  }

  async getByKey(key: string): Promise<SessionEntry | undefined> {
    return this.sessions.get(key);
  }

  async list(): Promise<SessionEntry[]> {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
}
