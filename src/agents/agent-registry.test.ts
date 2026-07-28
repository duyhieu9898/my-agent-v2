import { describe, expect, it } from "vitest";

import {
  AgentRegistry,
  canonicalize,
  hashResourceManifest,
  type AgentDefinition,
} from "./agent-registry.js";
import { primaryAgentDefinition } from "../test/foundation-fixtures.js";

function withOverride(override: Partial<AgentDefinition>): AgentDefinition {
  return { ...primaryAgentDefinition, ...override };
}

describe("AgentRegistry", () => {
  it("resolves one immutable pinned primary snapshot", () => {
    const snapshot = new AgentRegistry([primaryAgentDefinition]).resolve(
      undefined,
    );
    expect(snapshot.agentId).toBe("primary");
    expect(snapshot.modelRoute.modelId).toBe("gemini-3.5-flash");
    expect(snapshot.harnessId).toBe("builtin-step");
    expect(snapshot.promptProfile).toBe("main-v1");
    expect(snapshot.contextTokenBudget).toBe(12000);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.resourceManifestHash).toHaveLength(64);
  });

  it("fails unknown agents typed with no fallback to primary", () => {
    const registry = new AgentRegistry([primaryAgentDefinition]);
    let caught: unknown;
    try {
      registry.resolve("other");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      message: "AGENT_NOT_FOUND",
    });
  });

  it("fails duplicate agent ids at construction", () => {
    expect(
      () => new AgentRegistry([primaryAgentDefinition, primaryAgentDefinition]),
    ).toThrow("DUPLICATE_AGENT_DEFINITION");
  });

  it("produces a deterministic canonical resource manifest hash", () => {
    const hash = (def: AgentDefinition) =>
      new AgentRegistry([def]).resolve("primary").resourceManifestHash;
    expect(hash(primaryAgentDefinition)).toBe(hash(primaryAgentDefinition));
  });

  it("is independent of property construction order", () => {
    const reordered: AgentDefinition = {
      availability: "ready",
      memoryPolicyFingerprint: "none",
      sandboxPolicyFingerprint: "none",
      toolPolicyFingerprint: "none",
      toolRegistryFingerprint: "none",
      contextTokenBudget: 12000,
      tokenEstimatorRevision: "heuristic-v1",
      memoryProfile: "none",
      toolProfile: "none",
      promptProfile: "main-v1",
      harnessId: "builtin-step",
      modelRoute: {
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
      },
      agentRevision: "primary-v1",
      agentId: "primary",
    };
    expect(hashResourceManifest(reordered)).toBe(
      hashResourceManifest(primaryAgentDefinition),
    );
  });

  it.each([
    ["agentRevision", { agentRevision: "primary-v2" }],
    [
      "modelRoute.providerId",
      {
        modelRoute: {
          providerId: "other-provider",
          modelId: "gemini-3.5-flash",
        } as never,
      },
    ],
    [
      "modelRoute.modelId",
      {
        modelRoute: {
          providerId: "gemini-developer",
          modelId: "other-model",
        } as never,
      },
    ],
    ["harnessId", { harnessId: "other-harness" }],
    ["promptProfile", { promptProfile: "other-prompt" as never }],
    ["toolProfile", { toolProfile: "tools" as never }],
    ["memoryProfile", { memoryProfile: "memory" as never }],
    [
      "toolRegistryFingerprint",
      { toolRegistryFingerprint: "tools-v2" as never },
    ],
    ["toolPolicyFingerprint", { toolPolicyFingerprint: "tp-v2" as never }],
    [
      "sandboxPolicyFingerprint",
      { sandboxPolicyFingerprint: "sp-v2" as never },
    ],
    ["memoryPolicyFingerprint", { memoryPolicyFingerprint: "mp-v2" as never }],
    ["contextTokenBudget", { contextTokenBudget: 8000 }],
    ["tokenEstimatorRevision", { tokenEstimatorRevision: "heuristic-v2" }],
    ["availability", { availability: "deprecated" as never }],
  ])(
    "changes the hash independently when the authority field %s changes",
    (_name, override) => {
      const base = hashResourceManifest(primaryAgentDefinition);
      const changed = hashResourceManifest(withOverride(override));
      // The single-field change must produce a different hash than the base.
      expect(changed).not.toBe(base);
      // The changed hash must still be a deterministic SHA-256 representation.
      expect(changed).toMatch(/^[0-9a-f]{64}$/);
      // Identical semantic input must hash identically (determinism).
      expect(hashResourceManifest(withOverride(override))).toBe(changed);
    },
  );

  it("leaves the hash unchanged when an unrelated non-manifest field changes", () => {
    // `agentId` is identity, not an authority field: it must not affect the hash.
    const base = hashResourceManifest(primaryAgentDefinition);
    expect(
      hashResourceManifest(withOverride({ agentId: "some-other-agent-id" })),
    ).toBe(base);
  });

  it("never includes secrets in the resolved snapshot", () => {
    const snapshot = new AgentRegistry([primaryAgentDefinition]).resolve(
      "primary",
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("GEMINI_API_KEY");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("secret");
    expect(snapshot.resourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of nested modelRoute key order", () => {
    const reversedModelRoute: AgentDefinition = {
      ...primaryAgentDefinition,
      modelRoute: {
        modelId: "gemini-3.5-flash",
        providerId: "gemini-developer",
      },
    };
    expect(hashResourceManifest(reversedModelRoute)).toBe(
      hashResourceManifest(primaryAgentDefinition),
    );
  });
});

describe("resource manifest canonical serialization", () => {
  it("sorts object keys recursively including nested objects", () => {
    expect(JSON.stringify(canonicalize({ b: { d: 1, c: 2 }, a: 3 }))).toBe(
      '{"a":3,"b":{"c":2,"d":1}}',
    );
  });

  it("preserves array element order (does not sort arrays)", () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
    expect(JSON.stringify(canonicalize(["c", "a", "b"]))).toBe('["c","a","b"]');
  });

  it("disambiguates null, boolean, number, and string scalar values", () => {
    expect(JSON.stringify(canonicalize(null))).toBe("null");
    expect(JSON.stringify(canonicalize(true))).toBe("true");
    expect(JSON.stringify(canonicalize(0))).toBe("0");
    expect(JSON.stringify(canonicalize(""))).toBe('""');
    expect(JSON.stringify(canonicalize("0"))).toBe('"0"');
    const distinct = new Set(
      [null, false, true, 0, 1, "", "0", "1"].map((value) =>
        JSON.stringify(canonicalize(value)),
      ),
    );
    expect(distinct.size).toBe(8);
  });

  it("hashes Unicode authority strings deterministically and distinctly", () => {
    const umlaut = hashResourceManifest(
      withOverride({ agentRevision: "ünïcödé-v1" }),
    );
    const cjk = hashResourceManifest(
      withOverride({ agentRevision: "改訂-v1" }),
    );
    expect(
      hashResourceManifest(withOverride({ agentRevision: "ünïcödé-v1" })),
    ).toBe(umlaut);
    expect(umlaut).toMatch(/^[0-9a-f]{64}$/);
    expect(cjk).toMatch(/^[0-9a-f]{64}$/);
    expect(umlaut).not.toBe(cjk);
  });
});
