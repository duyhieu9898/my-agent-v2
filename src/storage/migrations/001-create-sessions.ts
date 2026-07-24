import type { Migration } from "./types.js";

export const migration001CreateSessions: Migration = {
  version: 1,
  name: "create_sessions",

  up(database) {
    database.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
