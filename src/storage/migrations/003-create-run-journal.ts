import type { Migration } from "./types.js";
export const migration003CreateRunJournal: Migration = {
  version: 3,
  name: "create_run_journal",
  up(database) {
    database.exec(
      `CREATE TABLE run_journal_entries (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_name TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence));`,
    );
  },
};
