import type { Migration } from "./types.js";
export const migration005CreateAttempts: Migration = {
  version: 5,
  name: "create_attempts",
  up(database) {
    database.exec(
      `CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, terminal_code TEXT); CREATE INDEX attempts_run_idx ON attempts (run_id);`,
    );
  },
};
