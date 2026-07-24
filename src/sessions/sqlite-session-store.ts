import { randomUUID } from "node:crypto";

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
    key: row.session_key,
    sessionId: row.session_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionStore implements SessionStore {
  public constructor(private readonly database: AppDatabase) {}

  async create(input: CreateSessionInput): Promise<SessionEntry> {
    const now = new Date().toISOString();

    const session: SessionEntry = {
      key: input.key,
      sessionId: randomUUID(),
      agentId: input.agentId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO sessions (
          session_key,
          session_id,
          agent_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        session.key,
        session.sessionId,
        session.agentId,
        session.createdAt,
        session.updatedAt,
      );

    return session;
  }

  async getByKey(key: string): Promise<SessionEntry | undefined> {
    const row = this.database
      .prepare(`
        SELECT session_key, session_id, agent_id, created_at, updated_at
        FROM sessions
        WHERE session_key = ?
      `)
      .get(key) as SessionRow | undefined;

    return row ? mapSession(row) : undefined;
  }

  async list(): Promise<SessionEntry[]> {
    const rows = this.database
      .prepare(`
        SELECT session_key, session_id, agent_id, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
      `)
      .all() as SessionRow[];

    return rows.map(mapSession);
  }
}
