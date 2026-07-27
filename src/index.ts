import { existsSync } from "node:fs";

import { createApp } from "./bootstrap/create-app.js";
import { loadConfig } from "./config/load-config.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const config = loadConfig();
const app = createApp(config);

let isStopping = false;

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (isStopping) {
    return;
  }

  isStopping = true;

  app.logger.info({ signal }, "shutdown requested");

  try {
    await app.stop();
  } catch (error: unknown) {
    app.logger.error({ error }, "failed to stop cleanly");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  process.once("SIGINT", () => {
    void stop("SIGINT");
  });

  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await app.start();
}

main().catch((error: unknown) => {
  app.logger.fatal({ error }, "failed to start my-agent-v2");
  process.exitCode = 1;
});
