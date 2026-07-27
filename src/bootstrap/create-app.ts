import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type Logger } from "pino";

import type { AppConfig } from "../config/config.schema.js";
import { createLogger } from "./create-logger.js";
import { createGateway } from "../gateway/create-gateway.js";
import { AgentRuntime } from "../agents/agent-runtime.js";
import { SqliteAttemptStore } from "../agents/attempt-store.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { StartupRunReconciler } from "../agents/startup-run-reconciler.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { RuntimeCapacity } from "../agents/runtime-capacity.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { GeminiInteractionsProvider } from "../models/gemini-interactions-provider.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";

export type App = {
  config: AppConfig;
  logger: Logger;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createApp(config: AppConfig): App {
  const logger = createLogger(config);

  mkdirSync(dirname(config.database.path), {
    recursive: true,
  });

  const database = openDatabase(config.database.path);

  migrateDatabase(database);

  const sessions = new SqliteSessionStore(database);
  const sessionResolver = new SessionResolver(sessions);
  const transcripts = new SqliteTranscriptStore(database);
  const runs = new SqliteRunStore(database);
  const attempts = new SqliteAttemptStore(database);
  const usageBudgetGate = new UsageBudgetGate(
    database,
    config.usage.capPolicies.map((policy) => ({
      id: policy.id,
      window: policy.window,
      enabled: policy.enabled,
      ...(policy.maxTokens === undefined
        ? {}
        : { maxTokens: policy.maxTokens }),
      ...(policy.maxCostMicros === undefined
        ? {}
        : { maxCostMicros: policy.maxCostMicros }),
      ...(policy.agentId === undefined ? {} : { agentId: policy.agentId }),
      ...(policy.providerId === undefined
        ? {}
        : { providerId: policy.providerId }),
      ...(policy.modelId === undefined ? {} : { modelId: policy.modelId }),
    })),
    config.usage.priceCatalog.map((price) => ({
      revision: price.revision,
      ...(price.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: price.effectiveFrom }),
      providerId: price.providerId,
      modelId: price.modelId,
      inputMicrosPerMillionTokens: price.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: price.outputMicrosPerMillionTokens,
    })),
  );
  const startupReconciler = new StartupRunReconciler(runs, usageBudgetGate);
  const geminiApiKey =
    process.env[config.agent.model.geminiApiKeyEnvironmentVariable];
  if (config.nodeEnv !== "test" && !geminiApiKey)
    throw new Error(
      `Missing Gemini credential: ${config.agent.model.geminiApiKeyEnvironmentVariable}`,
    );
  const journal = new SqliteRunJournalStore(database);
  const events = new RuntimeEventBus();
  const runtime = new AgentRuntime({
    sessions: sessionResolver,
    transcripts,
    runs,
    attempts,
    usageBudgetGate,
    ...(geminiApiKey
      ? { provider: new GeminiInteractionsProvider(geminiApiKey) }
      : {}),
    journal,
    events,
    lanes: new SessionRunLaneCoordinator(
      config.runtime.perSessionQueueCapacity,
    ),
    capacity: new RuntimeCapacity(config.runtime.maxConcurrentModelCalls),
    runTimeoutMs: config.runtime.runTimeoutMs,
  });

  const gateway = createGateway({
    host: config.gateway.host,
    port: config.gateway.port,
    logger: logger.child({ module: "gateway" }),
    dependencies: {
      sessions,
      sessionResolver,
      transcripts,
      runtime,
      events,
      runs,
      journal,
    },
  });

  return {
    config,
    logger,

    async start(): Promise<void> {
      await startupReconciler.reconcileInterruptedRuns(
        new Date().toISOString(),
      );
      await gateway.start();

      logger.info(
        {
          nodeEnv: config.nodeEnv,
          dataDir: config.dataDir,
          workspaceDir: config.workspaceDir,
          databasePath: config.database.path,
          defaultAgentId: config.agent.defaultId,
          model: config.agent.model.modelId,
          captureProfile: config.usage.captureProfile,
        },
        "my-agent-v2 started",
      );
    },

    async stop(): Promise<void> {
      await gateway.stop();
      database.close();
      logger.info("my-agent-v2 stopped");
    },
  };
}
