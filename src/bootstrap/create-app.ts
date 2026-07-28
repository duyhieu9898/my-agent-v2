import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type Logger } from "pino";

import type { AppConfig } from "../config/config.schema.js";
import { createLogger } from "./create-logger.js";
import { createGateway, type Gateway } from "../gateway/create-gateway.js";
import { AgentRuntime } from "../agents/agent-runtime.js";
import {
  AgentRegistry,
  type AgentDefinition,
} from "../agents/agent-registry.js";
import { BuiltinStepHarness } from "../agents/harness.js";
import { HarnessRegistry } from "../agents/harness-registry.js";
import { SqliteAttemptStore } from "../agents/attempt-store.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { StartupRunReconciler } from "../agents/startup-run-reconciler.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { RuntimeCapacity } from "../agents/runtime-capacity.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import {
  GeminiInteractionsProvider,
  type InteractionsClient,
} from "../models/gemini-interactions-provider.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";

export type App = {
  config: AppConfig;
  logger: Logger;
  runtime: AgentRuntime;
  gateway: Gateway;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Composition options. `geminiClient` is the only production-shaped injection
 * seam: when present the real provider is built with this client instead of a
 * real SDK client, enabling deterministic composed integration tests with no
 * network. The production default path is unchanged when it is absent.
 */
export type CreateAppOptions = {
  geminiClient?: InteractionsClient;
};

/**
 * Build the single primary agent definition from operator configuration. The
 * estimator revision is read from the estimator instance so the manifest cannot
 * drift from the estimator actually in use.
 */
function buildPrimaryDefinition(
  config: AppConfig,
  tokenEstimatorRevision: string,
): AgentDefinition {
  return {
    agentId: config.agent.defaultId,
    agentRevision: "primary-v1",
    modelRoute: {
      providerId: config.agent.model.providerId,
      modelId: config.agent.model.modelId,
    },
    harnessId: "builtin-step",
    promptProfile: "main-v1",
    toolProfile: "none",
    memoryProfile: "none",
    toolRegistryFingerprint: "none",
    toolPolicyFingerprint: "none",
    sandboxPolicyFingerprint: "none",
    memoryPolicyFingerprint: "none",
    contextTokenBudget: config.agent.model.contextTokenBudget,
    tokenEstimatorRevision,
    availability: "ready",
  };
}

export function createApp(
  config: AppConfig,
  options: CreateAppOptions = {},
): App {
  const logger = createLogger(config);

  mkdirSync(dirname(config.database.path), {
    recursive: true,
  });

  const database = openDatabase(config.database.path);

  migrateDatabase(database);

  const tokenEstimator = new HeuristicTokenEstimator();
  const agentRegistry = new AgentRegistry([
    buildPrimaryDefinition(config, tokenEstimator.revision),
  ]);
  const harnessRegistry = new HarnessRegistry([
    { id: "builtin-step", harness: new BuiltinStepHarness() },
  ]);
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
      ...(policy.revision === undefined ? {} : { revision: policy.revision }),
      ...(policy.ruleMetadata === undefined
        ? {}
        : { ruleMetadata: policy.ruleMetadata }),
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
  if (config.nodeEnv !== "test" && !geminiApiKey && !options.geminiClient)
    throw new Error(
      `Missing Gemini credential: ${config.agent.model.geminiApiKeyEnvironmentVariable}`,
    );
  const provider =
    options.geminiClient || geminiApiKey
      ? new GeminiInteractionsProvider(
          geminiApiKey ?? "unused-deterministic-client",
          options.geminiClient,
        )
      : undefined;
  const journal = new SqliteRunJournalStore(database);
  const events = new RuntimeEventBus();
  const runtime = new AgentRuntime({
    sessions: sessionResolver,
    transcripts,
    runs,
    attempts,
    usageBudgetGate,
    ...(provider ? { provider } : {}),
    journal,
    events,
    agentRegistry,
    harnessRegistry,
    tokenEstimator,
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
      usageBudgetGate,
    },
  });

  return {
    config,
    logger,
    runtime,
    gateway,

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
