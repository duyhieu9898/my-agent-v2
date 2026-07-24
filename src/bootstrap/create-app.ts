import { mkdirSync } from "node:fs";
import { join } from "node:path";

import pino, { type Logger } from "pino";

import type { AppConfig } from "../config/config.schema.js";
import { createGateway } from "../gateway/create-gateway.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";

export type App = {
  config: AppConfig;
  logger: Logger;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createApp(config: AppConfig): App {
  const logger = pino({
    name: "my-agent",
    level: config.logLevel,
  });

  mkdirSync(config.dataDir, {
    recursive: true,
  });

  const database = openDatabase(
    join(config.dataDir, "my-agent.sqlite"),
  );

  migrateDatabase(database);

  const sessions = new SqliteSessionStore(database);
  const sessionResolver = new SessionResolver(sessions);

  const gateway = createGateway({
    host: config.gateway.host,
    port: config.gateway.port,
    logger: logger.child({ module: "gateway" }),
    dependencies: {
      sessions,
      sessionResolver,
    },
  });

  return {
    config,
    logger,

    async start(): Promise<void> {
      await gateway.start();

      logger.info(
        {
          nodeEnv: config.nodeEnv,
          dataDir: config.dataDir,
          workspaceDir: config.workspaceDir,
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