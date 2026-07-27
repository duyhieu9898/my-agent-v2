import type { Migration } from "./types.js";

export const migration002CreateTranscriptEntries: Migration = {
  version: 2,
  name: "create_transcript_entries",
  up(database) {
    database.exec(`
      CREATE TABLE transcript_entries (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        parent_id TEXT,
        role TEXT,
        text_content TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_content_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, entry_id)
      );
      CREATE INDEX transcript_entries_session_sequence_idx
        ON transcript_entries (session_id, sequence);
      CREATE TABLE transcript_continuations (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        continuation_version TEXT NOT NULL,
        continuation_payload BLOB NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id, sequence)
          REFERENCES transcript_entries (session_id, sequence)
          ON DELETE CASCADE
      );
    `);
  },
};
