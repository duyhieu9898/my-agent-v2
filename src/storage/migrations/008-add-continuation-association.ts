import type { Migration } from "./types.js";
export const migration008AddContinuationAssociation: Migration = {
  version: 8,
  name: "add_continuation_association",
  up(database) {
    database.exec(
      "ALTER TABLE transcript_continuations ADD COLUMN provider_id TEXT; ALTER TABLE transcript_continuations ADD COLUMN model_id TEXT; ALTER TABLE transcript_continuations ADD COLUMN model_call_id TEXT; CREATE INDEX transcript_continuations_association_idx ON transcript_continuations (session_id, sequence, provider_id, model_id);",
    );
  },
};
