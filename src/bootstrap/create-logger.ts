import pino, { type Logger } from "pino";

import type { AppConfig } from "../config/config.schema.js";

const sensitiveLogPaths = [
  "geminiApiKey",
  "apiKey",
  "authorization",
  "password",
  "continuationPayload",
  "prompt",
  "providerPayload",
  "*.geminiApiKey",
  "*.apiKey",
  "*.authorization",
  "*.password",
  "*.continuationPayload",
  "*.prompt",
  "*.providerPayload",
];

export function createLogger(
  config: Pick<AppConfig, "logLevel">,
  destination?: pino.DestinationStream,
): Logger {
  return pino(
    {
      name: "my-agent",
      level: config.logLevel,
      redact: {
        paths: sensitiveLogPaths,
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
