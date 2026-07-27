import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteSessionStore } from "./sqlite-session-store.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import {
  createSequentialIdFactory,
  FakeClock,
} from "../test/foundation-fixtures.js";

let database: AppDatabase;
let repository: SqliteSessionStore;

beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
  repository = new SqliteSessionStore(database);
});

afterEach(() => {
  database.close();
});

describe("SqliteSessionStore", () => {
  it("creates a session entry", async () => {
    const session = await repository.create({
      key: "agent:primary:test-1",
      agentId: "primary",
    });

    expect(session.key).toBe("agent:primary:test-1");
    expect(session.sessionId).toEqual(expect.any(String));
    expect(session.agentId).toBe("primary");
    expect(session.createdAt).toEqual(expect.any(String));
    expect(session.updatedAt).toBe(session.createdAt);
  });

  it("gets an existing session entry", async () => {
    const created = await repository.create({
      key: "agent:primary:test-2",
      agentId: "primary",
    });

    const found = await repository.getByKey(created.key);

    expect(found).toEqual(created);
  });

  it("returns undefined for a missing session", async () => {
    const found = await repository.getByKey("missing-key");

    expect(found).toBeUndefined();
  });

  it("lists session entries", async () => {
    const first = await repository.create({
      key: "agent:primary:list-1",
      agentId: "primary",
    });
    const second = await repository.create({
      key: "agent:primary:list-2",
      agentId: "primary",
    });

    const sessions = await repository.list();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.key)).toEqual(
      expect.arrayContaining([first.key, second.key]),
    );
  });

  it("uses injected time and identity factories", async () => {
    repository = new SqliteSessionStore(database, {
      clock: new FakeClock(new Date("2026-07-24T00:00:00.000Z")),
      ids: createSequentialIdFactory(),
    });

    const session = await repository.create({
      key: "agent:primary:deterministic",
      agentId: "primary",
    });

    expect(session.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(session.createdAt).toBe("2026-07-24T00:00:00.000Z");
  });

  it("normalizes SQLite uniqueness failures at the storage boundary", async () => {
    await repository.create({
      key: "agent:primary:duplicate",
      agentId: "primary",
    });

    await expect(
      repository.create({
        key: "agent:primary:duplicate",
        agentId: "primary",
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_CONFLICT",
    });
  });

  it("replaces the transcript session ID on reset", async () => {
    const created = await repository.create({
      key: "agent:primary:reset",
      agentId: "primary",
    });
    const reset = await repository.reset(created.key);
    expect(reset?.key).toBe(created.key);
    expect(reset?.sessionId).not.toBe(created.sessionId);
  });
});
