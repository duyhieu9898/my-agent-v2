import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openDatabase,
  type AppDatabase,
} from "./database.js";
import { migrateDatabase } from "./migrate.js";

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
      .prepare(`
        SELECT version, name
        FROM schema_migrations
      `)
      .all();

    expect(rows).toEqual([
      {
        version: 1,
        name: "create_sessions",
      },
    ]);
  });

  it("is safe to run more than once", () => {
    migrateDatabase(database);
    migrateDatabase(database);

    const row = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM schema_migrations
      `)
      .get() as {
      count: number;
    };

    expect(row.count).toBe(1);
  });
});
