import { configSchema, type AppConfig } from "./config.schema.js";

export function loadConfig(): AppConfig {
  return configSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    dataDir: process.env.MY_AGENT_DATA_DIR,
    workspaceDir: process.env.MY_AGENT_WORKSPACE_DIR,

    gateway: {
      host: process.env.MY_AGENT_GATEWAY_HOST,
      port: process.env.MY_AGENT_GATEWAY_PORT,
    },
  });
}