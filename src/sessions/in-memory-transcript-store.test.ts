import { describe, expect, it } from "vitest";

import { InMemoryTranscriptStore } from "./in-memory-transcript-store.js";

describe("InMemoryTranscriptStore", () => {
  it("appends and reads transcript entries", async () => {
    const store = new InMemoryTranscriptStore();

    await store.append("session-1", {
      type: "message",
      id: "entry-1",
      role: "user",
      text: "Hello",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    expect(await store.read("session-1")).toEqual([
      {
        type: "message",
        id: "entry-1",
        role: "user",
        text: "Hello",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    ]);
  });

  it("keeps sessions isolated", async () => {
    const store = new InMemoryTranscriptStore();

    await store.append("session-1", {
      type: "message",
      id: "entry-1",
      role: "user",
      text: "One",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    expect(await store.read("session-2")).toEqual([]);
  });

  it("clears a transcript", async () => {
    const store = new InMemoryTranscriptStore();

    await store.append("session-1", {
      type: "message",
      id: "entry-1",
      role: "user",
      text: "Hello",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    await store.clear("session-1");

    expect(await store.read("session-1")).toEqual([]);
  });
});
