import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config/config.schema.js";
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
});
