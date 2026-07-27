import { createHash } from "node:crypto";

export type ResolvedAgentSnapshot = Readonly<{
  agentId: "primary";
  agentRevision: string;
  availability: "ready";
  modelRoute: Readonly<{
    providerId: "gemini-developer";
    modelId: "gemini-3.5-flash";
  }>;
  harnessId: "builtin-step";
  promptProfile: "main-v1";
  resourceManifestHash: string;
  toolRegistryFingerprint: "none";
  toolPolicyFingerprint: "none";
  sandboxPolicyFingerprint: "none";
  memoryPolicyFingerprint: "none";
}>;

export class AgentRegistry {
  resolve(agentId: string | undefined): ResolvedAgentSnapshot {
    if (agentId !== undefined && agentId !== "primary")
      throw new Error("AGENT_NOT_FOUND");
    const revision = "primary-v1";
    return Object.freeze({
      agentId: "primary",
      agentRevision: revision,
      availability: "ready",
      modelRoute: Object.freeze({
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
      }),
      harnessId: "builtin-step",
      promptProfile: "main-v1",
      resourceManifestHash: hash(revision),
      toolRegistryFingerprint: "none",
      toolPolicyFingerprint: "none",
      sandboxPolicyFingerprint: "none",
      memoryPolicyFingerprint: "none",
    });
  }
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
