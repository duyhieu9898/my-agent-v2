import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "./database.js";

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("openDatabase", () => {
  it("enforces foreign keys and configures bounded contention", () => {
    database = openDatabase(":memory:", { busyTimeoutMs: 250 });

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(250);
  });
});
