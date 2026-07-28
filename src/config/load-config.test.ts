import { describe, expect, it } from "vitest";

import { loadConfig } from "./load-config.js";

describe("loadConfig", () => {
  it("builds the database location from the configured data directory", () => {
    const config = loadConfig({
      MY_AGENT_DATA_DIR: "/tmp/my-agent-data",
    });

    expect(config.database.path).toBe("/tmp/my-agent-data/my-agent.sqlite");
  });

  it("keeps the Gemini credential as a secret reference", () => {
    const config = loadConfig({
      MY_AGENT_GEMINI_API_KEY_ENV: "MY_TEST_GEMINI_KEY",
      MY_TEST_GEMINI_KEY: "not-for-config-serialization",
    });

    expect(config.agent.model).toEqual({
      providerId: "gemini-developer",
      modelId: "gemini-3.5-flash",
      geminiApiKeyEnvironmentVariable: "MY_TEST_GEMINI_KEY",
      contextTokenBudget: 12000,
    });
    expect(JSON.stringify(config)).not.toContain(
      "not-for-config-serialization",
    );
  });

  it("validates bounded runtime and usage inputs", () => {
    expect(() =>
      loadConfig({
        MY_AGENT_SESSION_QUEUE_CAPACITY: "0",
      }),
    ).toThrow();

    expect(() =>
      loadConfig({
        MY_AGENT_USAGE_CAP_POLICIES_JSON: "not-json",
      }),
    ).toThrow(SyntaxError);
  });

  it("accepts configured price and cap records without loading secrets", () => {
    const config = loadConfig({
      MY_AGENT_USAGE_PRICE_CATALOG_JSON: JSON.stringify([
        {
          revision: "2026-07-24",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          effectiveFrom: "2026-07-24T00:00:00.000Z",
          inputMicrosPerMillionTokens: "100",
          outputMicrosPerMillionTokens: "200",
        },
      ]),
      MY_AGENT_USAGE_CAP_POLICIES_JSON: JSON.stringify([
        {
          id: "global-day",
          revision: 1,
          window: "day",
          maxTokens: "1000000",
          enabled: true,
        },
      ]),
    });

    expect(config.usage.priceCatalog).toHaveLength(1);
    expect(config.usage.capPolicies).toHaveLength(1);
  });
});
