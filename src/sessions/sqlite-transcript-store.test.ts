import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";
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
  it("enforces one continuation sidecar per transcript exchange", async () => {
    await store.appendBatch({
      sessionId: "session-continuation-unique",
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "user-entry",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "assistant-entry",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
          continuation: {
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("signature"),
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-A",
          },
        },
      ],
    });

    expect(() =>
      database
        .prepare(
          `INSERT INTO transcript_continuations (
            session_id, sequence, continuation_version, continuation_payload,
            provider_id, model_id, model_call_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session-continuation-unique",
          2,
          "gemini-thought-signature-v1",
          new TextEncoder().encode("duplicate"),
          "gemini-developer",
          "gemini-3.5-flash",
          "model-call-A",
        ),
    ).toThrow();
  });

  it("preserves assistant model call id across SQLite reopen", async () => {
    const temporaryDatabase = createTemporaryDatabase();
    migrateDatabase(temporaryDatabase.database);
    const initialStore = new SqliteTranscriptStore(temporaryDatabase.database);

    await initialStore.appendBatch({
      sessionId: "session-model-call-round-trip",
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "user-entry",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "assistant-entry",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
        },
      ],
    });
    temporaryDatabase.database.close();

    const reopenedDatabase = openDatabase(temporaryDatabase.path);
    migrateDatabase(reopenedDatabase);
    const reopenedStore = new SqliteTranscriptStore(reopenedDatabase);
    const page = await reopenedStore.readPage("session-model-call-round-trip");
    reopenedDatabase.close();
    temporaryDatabase.close();

    const [userEntry, assistantEntry] = page.entries;
    expect(userEntry).toMatchObject({
      id: "user-entry",
      sequence: 1,
      type: "message",
      role: "user",
    });
    expect(userEntry).not.toHaveProperty("modelCallId");
    expect(assistantEntry).toMatchObject({
      id: "assistant-entry",
      sequence: 2,
      type: "message",
      role: "assistant",
      continuationRequired: true,
      modelCallId: "model-call-A",
    });
  });

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
