import type { Migration } from "./types.js";
export const migration009AddTranscriptModelCallAssociation: Migration = {
  version: 9,
  name: "add_transcript_model_call_association",
  up(database) {
    database.exec(
      "ALTER TABLE transcript_entries ADD COLUMN model_call_id TEXT; CREATE INDEX transcript_entries_model_call_idx ON transcript_entries (session_id, model_call_id);",
    );
  },
};
