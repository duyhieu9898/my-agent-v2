import type { Migration } from "./types.js";

export const migration007AddContinuationRequired: Migration = {
  version: 7,
  name: "add_continuation_required",
  up(database) {
    database.exec(
      "ALTER TABLE transcript_entries ADD COLUMN continuation_required INTEGER NOT NULL DEFAULT 0;",
    );
  },
};
