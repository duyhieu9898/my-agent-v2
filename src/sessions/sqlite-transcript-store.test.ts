import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { SqliteTranscriptStore } from "./sqlite-transcript-store.js";

let database: AppDatabase;
let store: SqliteTranscriptStore;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
  store = new SqliteTranscriptStore(database);
});
afterEach(() => database.close());

describe("SqliteTranscriptStore", () => {
  it("rolls back an entire batch when one entry conflicts", async () => {
    await store.appendBatch({
      sessionId: "session-1",
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "existing",
          role: "user",
          text: "One",
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    });
    await expect(
      store.appendBatch({
        sessionId: "session-1",
        expectedTailSequence: 1,
        entries: [
          {
            type: "message",
            id: "new",
            role: "assistant",
            text: "Two",
            createdAt: "2026-07-24T00:00:01.000Z",
          },
          {
            type: "message",
            id: "existing",
            role: "user",
            text: "Duplicate",
            createdAt: "2026-07-24T00:00:02.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    expect((await store.readPage("session-1")).entries).toHaveLength(1);
  });
});
