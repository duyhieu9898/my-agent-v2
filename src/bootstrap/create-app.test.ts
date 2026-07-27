import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config/config.schema.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { createApp } from "./create-app.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createApp", () => {
  it("creates and closes the configured database lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "my-agent-app-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nested", "agent.sqlite");

    const config: AppConfig = {
      nodeEnv: "test",
      logLevel: "error",
      dataDir: directory,
      workspaceDir: join(directory, "workspace"),
      database: {
        path: databasePath,
      },
      gateway: {
        host: "127.0.0.1",
        port: 0,
      },
      runtime: {
        perSessionQueueCapacity: 16,
        maxConcurrentModelCalls: 4,
        runTimeoutMs: 60_000,
      },
      agent: {
        defaultId: "primary",
        model: {
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          geminiApiKeyEnvironmentVariable: "GEMINI_API_KEY",
        },
      },
      usage: {
        captureProfile: "production",
        maxOutputTokens: 8_192,
        thinkingTokens: 0,
        reservationSafetyMarginTokens: 256,
        priceCatalog: [],
        capPolicies: [],
      },
    };

    const app = createApp(config);

    await app.start();
    expect(existsSync(databasePath)).toBe(true);
    await app.stop();
  });

  it("fails startup before opening Gateway when interrupted-run reconciliation cannot commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "my-agent-app-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");
    const config: AppConfig = {
      nodeEnv: "test",
      logLevel: "error",
      dataDir: directory,
      workspaceDir: join(directory, "workspace"),
      database: { path: databasePath },
      gateway: { host: "127.0.0.1", port: 0 },
      runtime: {
        perSessionQueueCapacity: 16,
        maxConcurrentModelCalls: 4,
        runTimeoutMs: 60_000,
      },
      agent: {
        defaultId: "primary",
        model: {
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          geminiApiKeyEnvironmentVariable: "GEMINI_API_KEY",
        },
      },
      usage: {
        captureProfile: "production",
        maxOutputTokens: 8_192,
        thinkingTokens: 0,
        reservationSafetyMarginTokens: 256,
        priceCatalog: [],
        capPolicies: [],
      },
    };
    const seed = openDatabase(databasePath);
    migrateDatabase(seed);
    await new SqliteRunStore(seed).create({
      runId: "interrupted-run",
      agentId: "primary",
      sessionKey: "agent:primary:main",
      sessionId: "session-1",
      status: "running",
      inputText: "interrupted",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });
    seed.exec(
      "CREATE TRIGGER reject_reconciliation BEFORE UPDATE OF status ON runs WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;",
    );
    seed.close();

    const failedStart = createApp(config);
    await expect(failedStart.start()).rejects.toThrow("storage unavailable");
    await failedStart.stop();

    const repair = openDatabase(databasePath);
    repair.exec("DROP TRIGGER reject_reconciliation");
    repair.close();
    const recoveredStart = createApp(config);
    await expect(recoveredStart.start()).resolves.toBeUndefined();
    await recoveredStart.stop();
  });
});
