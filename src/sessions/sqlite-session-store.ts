import { nowIso, systemClock, type Clock } from "../core/clock.js";
import {
  createAgentId,
  createSessionId,
  createSessionKey,
  randomIdFactory,
  type IdFactory,
} from "../core/identities.js";
import { normalizeStorageError } from "../core/errors.js";
import type { AppDatabase } from "../storage/database.js";
import type { SessionEntry } from "./session-entry.js";
import type { CreateSessionInput, SessionStore } from "./session-store.js";

type SessionRow = {
  session_key: string;
  session_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
};

function mapSession(row: SessionRow): SessionEntry {
  return {
    key: createSessionKey(row.session_key),
    sessionId: createSessionId(row.session_id),
    agentId: createAgentId(row.agent_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionStore implements SessionStore {
  public constructor(
    private readonly database: AppDatabase,
    private readonly dependencies: {
      clock?: Clock;
      ids?: IdFactory;
    } = {},
  ) {}

  async create(input: CreateSessionInput): Promise<SessionEntry> {
    const now = nowIso(this.dependencies.clock ?? systemClock);

    const session: SessionEntry = {
      key: createSessionKey(input.key),
      sessionId: (this.dependencies.ids ?? randomIdFactory).nextSessionId(),
      agentId: createAgentId(input.agentId),
      createdAt: now,
      updatedAt: now,
    };

    try {
      this.database
        .prepare(
          `
        INSERT INTO sessions (
          session_key,
          session_id,
          agent_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(
          session.key,
          session.sessionId,
          session.agentId,
          session.createdAt,
          session.updatedAt,
        );
    } catch (error: unknown) {
      throw normalizeStorageError(error);
    }

    return session;
  }

  async getByKey(key: string): Promise<SessionEntry | undefined> {
    const row = this.database
      .prepare(
        `
        SELECT session_key, session_id, agent_id, created_at, updated_at
        FROM sessions
        WHERE session_key = ?
      `,
      )
      .get(key) as SessionRow | undefined;

    return row ? mapSession(row) : undefined;
  }

  async list(): Promise<SessionEntry[]> {
    const rows = this.database
      .prepare(
        `
        SELECT session_key, session_id, agent_id, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
      `,
      )
      .all() as SessionRow[];

    return rows.map(mapSession);
  }

  async reset(key: string): Promise<SessionEntry | undefined> {
    const existing = await this.getByKey(key);
    if (!existing) return undefined;
    const updatedAt = nowIso(this.dependencies.clock ?? systemClock);
    const sessionId = (
      this.dependencies.ids ?? randomIdFactory
    ).nextSessionId();
    this.database
      .prepare(
        "UPDATE sessions SET session_id = ?, updated_at = ? WHERE session_key = ?",
      )
      .run(sessionId, updatedAt, key);
    return { ...existing, sessionId, updatedAt };
  }
}
