import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "./database.js";
import { migrateDatabase } from "./migrate.js";
import type { Migration } from "./migrations/types.js";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";

let database: AppDatabase;

beforeEach(() => {
  database = openDatabase(":memory:");
});

afterEach(() => {
  database.close();
});

describe("migrateDatabase", () => {
  it("applies migrations", () => {
    migrateDatabase(database);

    const rows = database
      .prepare(
        `
        SELECT version, name
        FROM schema_migrations
      `,
      )
      .all();

    expect(rows).toEqual([
      {
        version: 1,
        name: "create_sessions",
      },
      {
        version: 2,
        name: "create_transcript_entries",
      },
      {
        version: 3,
        name: "create_run_journal",
      },
      {
        version: 4,
        name: "create_runs",
      },
      {
        version: 5,
        name: "create_attempts",
      },
      {
        version: 6,
        name: "create_usage_ledger",
      },
    ]);
  });

  it("is safe to run more than once", () => {
    migrateDatabase(database);
    migrateDatabase(database);

    const row = database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM schema_migrations
      `,
      )
      .get() as {
      count: number;
    };

    expect(row.count).toBe(6);
  });

  it("rolls back a failed migration and does not record it", () => {
    const failingMigration: Migration = {
      version: 2,
      name: "failing_migration",
      up(currentDatabase) {
        currentDatabase.exec(
          "CREATE TABLE migration_should_not_persist (id INTEGER PRIMARY KEY)",
        );
        throw new Error("forced migration failure");
      },
    };

    expect(() => migrateDatabase(database, [failingMigration])).toThrow(
      "forced migration failure",
    );

    const migration = database
      .prepare("SELECT version FROM schema_migrations WHERE version = 2")
      .get();
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_should_not_persist'",
      )
      .get();

    expect(migration).toBeUndefined();
    expect(table).toBeUndefined();
  });

  it("does not reapply completed migrations after database reopen", () => {
    const temporaryDatabase = createTemporaryDatabase();
    temporaryDatabase.database.close();

    const firstDatabase = openDatabase(temporaryDatabase.path);
    migrateDatabase(firstDatabase);
    firstDatabase.close();

    const reopenedDatabase = openDatabase(temporaryDatabase.path);
    migrateDatabase(reopenedDatabase);
    const count = reopenedDatabase
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    reopenedDatabase.close();
    temporaryDatabase.close();

    expect(count.count).toBe(6);
  });
});
