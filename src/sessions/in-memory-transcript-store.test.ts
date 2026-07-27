import { describe, expect, it } from "vitest";

import { InMemoryTranscriptStore } from "./in-memory-transcript-store.js";
import { validateCompleteExchangeGroups } from "./transcript-entry.js";

const user = (id: string, text: string) => ({
  type: "message" as const,
  id,
  role: "user" as const,
  text,
  createdAt: "2026-07-24T00:00:00.000Z",
});
const assistant = (id: string, text: string) => ({
  type: "message" as const,
  id,
  role: "assistant" as const,
  text,
  createdAt: "2026-07-24T00:00:01.000Z",
});

describe("InMemoryTranscriptStore", () => {
  it("assigns contiguous sequences in an atomic batch", async () => {
    const store = new InMemoryTranscriptStore();
    const entries = await store.appendBatch({
      sessionId: "session-1",
      expectedTailSequence: 0,
      entries: [user("u1", "Hello"), assistant("a1", "Hi")],
    });
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    await expect(
      store.appendBatch({
        sessionId: "session-1",
        expectedTailSequence: 0,
        entries: [user("u2", "Conflict")],
      }),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_TAIL_CONFLICT" });
    expect((await store.readPage("session-1")).entries).toHaveLength(2);
  });

  it("keeps continuation opaque and cursor session-bound", async () => {
    const store = new InMemoryTranscriptStore();
    await store.appendBatch({
      sessionId: "session-1",
      expectedTailSequence: 0,
      entries: [
        user("u1", "Hello"),
        {
          ...assistant("a1", "Hi"),
          continuation: { version: "v1", payload: new Uint8Array([1, 2]) },
        },
        user("u2", "Again"),
      ],
    });
    const page = await store.readPage("session-1", { limit: 2 });
    expect(page.entries).not.toHaveProperty("continuation");
    expect(await store.readContinuation("session-1", 2)).toEqual({
      version: "v1",
      payload: new Uint8Array([1, 2]),
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    if (!page.nextCursor) {
      throw new Error("Expected transcript cursor");
    }
    await expect(
      store.readPage("replacement-session", { cursor: page.nextCursor }),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CURSOR_INVALID" });
  });

  it("validates complete exchange groups", () => {
    expect(() =>
      validateCompleteExchangeGroups([{ ...user("u1", "Hello"), sequence: 1 }]),
    ).toThrow("incomplete");
  });
});
