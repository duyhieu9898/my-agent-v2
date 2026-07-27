import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
let database: AppDatabase;
let store: SqliteRunJournalStore;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
  store = new SqliteRunJournalStore(database);
});
afterEach(() => database.close());
describe("SqliteRunJournalStore", () => {
  it("allocates monotonic sequences under concurrent appends", async () => {
    const entries = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.append({
          runId: "run-1",
          eventName: "stage.completed",
          payload: { index },
          occurredAt: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );
    expect(
      entries.map((entry) => entry.sequence).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
