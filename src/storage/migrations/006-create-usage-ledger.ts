import type { Migration } from "./types.js";

export const migration006CreateUsageLedger: Migration = {
  version: 6,
  name: "create_usage_ledger",
  up(database) {
    database.exec(`
      CREATE TABLE usage_reservations (
        usage_reservation_id TEXT PRIMARY KEY,
        model_call_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        reserved_tokens TEXT NOT NULL,
        reserved_cost_micros TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT
      );
      CREATE INDEX usage_reservations_window_idx ON usage_reservations (status, window_start);
      CREATE TABLE usage_records (
        usage_record_id TEXT PRIMARY KEY,
        usage_reservation_id TEXT NOT NULL UNIQUE,
        outcome TEXT NOT NULL,
        provider_total_tokens TEXT,
        input_tokens TEXT,
        output_tokens TEXT,
        cost_micros TEXT,
        cost_measurement TEXT NOT NULL,
        price_revision TEXT,
        occurred_at TEXT NOT NULL
      );
    `);
  },
};
