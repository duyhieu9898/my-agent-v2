import type { Migration } from "./types.js";
export const migration004CreateRuns: Migration = {
  version: 4,
  name: "create_runs",
  up(database) {
    database.exec(
      `CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_key TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, input_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_code TEXT); CREATE INDEX runs_session_status_idx ON runs (agent_id, session_key, status);`,
    );
  },
};
