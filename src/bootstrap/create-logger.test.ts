import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./create-logger.js";

describe("createLogger", () => {
  it("redacts secrets and unrestricted provider payloads", () => {
    const destination = new PassThrough();
    let output = "";
    destination.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const logger = createLogger({ logLevel: "info" }, destination);
    logger.info({
      geminiApiKey: "secret-key",
      prompt: "private prompt",
      providerPayload: {
        thoughtSignature: "private-signature",
      },
      request: {
        authorization: "Bearer secret",
      },
    });

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-key");
    expect(output).not.toContain("private prompt");
    expect(output).not.toContain("private-signature");
    expect(output).not.toContain("Bearer secret");
  });
});
