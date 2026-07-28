import type { Migration } from "./types.js";
export const migration010AddUsagePolicyMetadata: Migration = {
  version: 10,
  name: "add_usage_policy_metadata",
  up(database) {
    database.exec(
      "ALTER TABLE usage_reservations ADD COLUMN matched_policy_ids TEXT; ALTER TABLE usage_reservations ADD COLUMN policy_revision TEXT; ALTER TABLE usage_reservations ADD COLUMN rule_metadata TEXT; ALTER TABLE usage_records ADD COLUMN matched_policy_ids TEXT; ALTER TABLE usage_records ADD COLUMN policy_revision TEXT; ALTER TABLE usage_records ADD COLUMN rule_metadata TEXT;",
    );
  },
};
