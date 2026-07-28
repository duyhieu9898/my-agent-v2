import { createHash } from "node:crypto";

import { AppError } from "../core/errors.js";

/**
 * Authority-bearing, non-secret inputs that select execution behavior for one
 * resolved agent. Every field here must influence execution or execution
 * identity. Credentials, API keys, environment secrets, and mutable runtime
 * objects are deliberately excluded.
 */
export type AgentResourceManifest = Readonly<{
  agentRevision: string;
  modelRoute: Readonly<{
    providerId: "gemini-developer";
    modelId: "gemini-3.5-flash";
  }>;
  harnessId: string;
  promptProfile: "main-v1";
  toolProfile: "none";
  memoryProfile: "none";
  toolRegistryFingerprint: "none";
  toolPolicyFingerprint: "none";
  sandboxPolicyFingerprint: "none";
  memoryPolicyFingerprint: "none";
  contextTokenBudget: number;
  tokenEstimatorRevision: string;
  availability: "ready";
}>;

/**
 * A registered agent definition. `agentId` identifies which definition this is;
 * the remaining fields are the resource manifest.
 */
export type AgentDefinition = Readonly<
  AgentResourceManifest & { agentId: string }
>;

/**
 * The immutable snapshot resolved once per accepted run. It extends the
 * definition with a stable `resourceManifestHash` computed from the canonical
 * manifest. No credential or mutable handle is ever present.
 */
export type ResolvedAgentSnapshot = Readonly<
  AgentDefinition & { resourceManifestHash: string }
>;

/**
 * Deterministic, key-order-independent canonical JSON serialization. Object
 * property insertion order never affects the output; arrays keep their semantic
 * order. Output is UTF-8. Exported so canonicalization invariants (array order,
 * null/boolean/number/string disambiguation, Unicode) can be proven directly,
 * since the strict manifest type does not expose those value shapes.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

function manifestOf(definition: AgentDefinition): AgentResourceManifest {
  const {
    agentId: _agentId,
    agentRevision,
    modelRoute,
    harnessId,
    promptProfile,
    toolProfile,
    memoryProfile,
    toolRegistryFingerprint,
    toolPolicyFingerprint,
    sandboxPolicyFingerprint,
    memoryPolicyFingerprint,
    contextTokenBudget,
    tokenEstimatorRevision,
    availability,
  } = definition;
  return {
    agentRevision,
    modelRoute,
    harnessId,
    promptProfile,
    toolProfile,
    memoryProfile,
    toolRegistryFingerprint,
    toolPolicyFingerprint,
    sandboxPolicyFingerprint,
    memoryPolicyFingerprint,
    contextTokenBudget,
    tokenEstimatorRevision,
    availability,
  };
}

/** Hash the canonical manifest. Identical semantic inputs always hash equally. */
export function hashResourceManifest(definition: AgentDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifestOf(definition))))
    .digest("hex");
}

/**
 * Bootstrap-owned registry of agent definitions. Unknown agents fail typed
 * resolution with no fallback. Duplicate agent ids fail at construction.
 */
export class AgentRegistry {
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;

  public constructor(definitions: readonly AgentDefinition[]) {
    const table = new Map<string, AgentDefinition>();
    for (const definition of definitions) {
      if (table.has(definition.agentId))
        throw new AppError(
          "DOMAIN_VALIDATION_FAILED",
          `DUPLICATE_AGENT_DEFINITION: ${definition.agentId}`,
        );
      table.set(definition.agentId, definition);
    }
    this.definitions = table;
  }

  public resolve(agentId: string | undefined): ResolvedAgentSnapshot {
    const definition = this.definitions.get(agentId ?? "primary");
    if (!definition)
      throw new AppError("DOMAIN_VALIDATION_FAILED", "AGENT_NOT_FOUND");
    return Object.freeze({
      ...definition,
      resourceManifestHash: hashResourceManifest(definition),
    });
  }
}
