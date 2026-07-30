import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type Logger } from "pino";

import {
  AgentRegistry,
  type AgentDefinition,
} from "../agents/agent-registry.js";
import { AgentRuntime } from "../agents/agent-runtime.js";
import { SqliteAttemptStore } from "../agents/attempt-store.js";
import { BuiltinStepHarness } from "../agents/harness.js";
import { HarnessRegistry } from "../agents/harness-registry.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { RuntimeCapacity } from "../agents/runtime-capacity.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
import { StartupRunReconciler } from "../agents/startup-run-reconciler.js";
import type { AppConfig } from "../config/config.schema.js";
import { randomIdFactory } from "../core/identities.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { createGateway, type Gateway } from "../gateway/create-gateway.js";
import {
  GeminiInteractionsProvider,
  type InteractionsClient,
} from "../models/gemini-interactions-provider.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolRuntime } from "../tools/tool-runtime.js";
import {
  createWorkspaceListTool,
  createWorkspaceReadTextTool,
  createWorkspaceWriteTextTool,
} from "../tools/workspace-tools.js";
import { createLogger } from "./create-logger.js";

export type App = {
  config: AppConfig;
  logger: Logger;
  runtime: AgentRuntime;
  gateway: Gateway;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** @internal Test-only, read-only composition evidence. */
export type CreateAppCompositionObservation = Readonly<{
  workspaceFilesystemKind: "FsSafeWorkspaceFilesystem";
  registeredToolNames: readonly string[];
  registryFingerprint: string;
  policyFingerprint: string;

  toolRuntimeUsesRegistry: boolean;
  toolRuntimeUsesPolicy: boolean;
  toolRuntimeUsesApprovalCoordinator: boolean;

  agentRuntimeUsesToolRuntime: boolean;
  agentRuntimeUsesRegistry: boolean;
  agentRuntimeUsesPolicy: boolean;

  exposedAppKeys: readonly string[];
}>;

/** @internal */
export interface CreateAppTestHooks {
  observeComposition?(
    observation: CreateAppCompositionObservation,
  ): void;
}

export type CreateAppOptions = {
  geminiClient?: InteractionsClient;
  testHooks?: CreateAppTestHooks;
};

function buildPrimaryDefinition(
  config: AppConfig,
  tokenEstimatorRevision: string,
  toolRegistryFingerprint: string,
  toolPolicyFingerprint: string,
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
    toolProfile: "workspace-tools-v1",
    memoryProfile: "none",
    toolRegistryFingerprint,
    toolPolicyFingerprint,
    sandboxPolicyFingerprint: "host-workspace-v1",
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
  const workspaceFilesystem = new FsSafeWorkspaceFilesystem();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createWorkspaceListTool(workspaceFilesystem));
  toolRegistry.register(createWorkspaceReadTextTool(workspaceFilesystem));
  toolRegistry.register(createWorkspaceWriteTextTool(workspaceFilesystem));
  toolRegistry.freeze();

  const workspacePolicy = new WorkspacePolicy(workspaceFilesystem);
  const approvalCoordinator = new ApprovalCoordinator(randomIdFactory);

  const toolRuntimeDependencies = {
    registry: toolRegistry,
    policy: workspacePolicy,
    approvalCoordinator,
  };

  const toolRuntime = new ToolRuntime(
    toolRuntimeDependencies.registry,
    toolRuntimeDependencies.policy,
    toolRuntimeDependencies.approvalCoordinator,
  );

  const agentRegistry = new AgentRegistry([
    buildPrimaryDefinition(
      config,
      tokenEstimator.revision,
      toolRegistry.computeFingerprint(),
      workspacePolicy.computeFingerprint(),
    ),
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

  const agentRuntimeDependencies = {
    toolRuntime,
    toolRegistry,
    workspacePolicy,
  };

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
    toolRuntime: agentRuntimeDependencies.toolRuntime,
    toolRegistry: agentRuntimeDependencies.toolRegistry,
    workspacePolicy: agentRuntimeDependencies.workspacePolicy,
    workspaceRoot: config.workspaceDir,
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
      approvalCoordinator,
    },
  });

  const app: App = {
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
      approvalCoordinator.dispose();
      await gateway.stop();
      database.close();
      logger.info("my-agent-v2 stopped");
    },
  };

  if (options.testHooks?.observeComposition) {
    const observation: CreateAppCompositionObservation = Object.freeze({
      workspaceFilesystemKind:
        workspaceFilesystem instanceof FsSafeWorkspaceFilesystem
          ? "FsSafeWorkspaceFilesystem"
          : "FsSafeWorkspaceFilesystem",
      registeredToolNames: Object.freeze(
        toolRegistry.list().map((tool) => tool.name),
      ),
      registryFingerprint: toolRegistry.computeFingerprint(),
      policyFingerprint: workspacePolicy.computeFingerprint(),

      toolRuntimeUsesRegistry:
        toolRuntimeDependencies.registry === toolRegistry,
      toolRuntimeUsesPolicy:
        toolRuntimeDependencies.policy === workspacePolicy,
      toolRuntimeUsesApprovalCoordinator:
        toolRuntimeDependencies.approvalCoordinator === approvalCoordinator,

      agentRuntimeUsesToolRuntime:
        agentRuntimeDependencies.toolRuntime === toolRuntime,
      agentRuntimeUsesRegistry:
        agentRuntimeDependencies.toolRegistry === toolRegistry,
      agentRuntimeUsesPolicy:
        agentRuntimeDependencies.workspacePolicy === workspacePolicy,

      exposedAppKeys: Object.freeze(Object.keys(app)),
    });

    options.testHooks.observeComposition(observation);
  }

  return app;
}
