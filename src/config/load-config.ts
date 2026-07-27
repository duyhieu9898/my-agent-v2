import { join } from "node:path";

import { configSchema, type AppConfig } from "./config.schema.js";

type Environment = Record<string, string | undefined>;

function parseJsonEnvironment(environment: Environment, name: string): unknown {
  const value = environment[name];

  return value === undefined ? undefined : JSON.parse(value);
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  const dataDir = environment.MY_AGENT_DATA_DIR ?? "./data";

  return configSchema.parse({
    nodeEnv: environment.NODE_ENV,
    logLevel: environment.LOG_LEVEL,
    dataDir,
    workspaceDir: environment.MY_AGENT_WORKSPACE_DIR,

    database: {
      path:
        environment.MY_AGENT_DATABASE_PATH ?? join(dataDir, "my-agent.sqlite"),
    },

    gateway: {
      host: environment.MY_AGENT_GATEWAY_HOST,
      port: environment.MY_AGENT_GATEWAY_PORT,
    },

    runtime: {
      perSessionQueueCapacity: environment.MY_AGENT_SESSION_QUEUE_CAPACITY,
      maxConcurrentModelCalls: environment.MY_AGENT_MODEL_CONCURRENCY,
      runTimeoutMs: environment.MY_AGENT_RUN_TIMEOUT_MS,
    },

    agent: {
      defaultId: environment.MY_AGENT_DEFAULT_AGENT_ID,
      model: {
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        geminiApiKeyEnvironmentVariable:
          environment.MY_AGENT_GEMINI_API_KEY_ENV,
      },
    },

    usage: {
      captureProfile: environment.MY_AGENT_CAPTURE_PROFILE,
      maxOutputTokens: environment.MY_AGENT_MAX_OUTPUT_TOKENS,
      thinkingTokens: environment.MY_AGENT_THINKING_TOKENS,
      reservationSafetyMarginTokens:
        environment.MY_AGENT_USAGE_SAFETY_MARGIN_TOKENS,
      priceCatalog: parseJsonEnvironment(
        environment,
        "MY_AGENT_USAGE_PRICE_CATALOG_JSON",
      ),
      capPolicies: parseJsonEnvironment(
        environment,
        "MY_AGENT_USAGE_CAP_POLICIES_JSON",
      ),
    },
  });
}
