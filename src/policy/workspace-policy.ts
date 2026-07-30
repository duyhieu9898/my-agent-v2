import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ToolDescriptor } from "../tools/contracts.js";
import type {
  WorkspaceFilesystem,
  WorkspaceOperation,
} from "../tools/workspace-filesystem.js";
import { normalizeWorkspaceTarget } from "../tools/workspace-target.js";

export type PolicyDecisionType = "allow" | "deny" | "require-approval";

export interface InvocationPolicyResult {
  decision: PolicyDecisionType;
  reason: string;
  policyProfile: string;
  policyVersion: string;
  targetPath?: string;
  policyConstraints?: Record<string, unknown>;
  redactionMetadata?: Record<string, unknown>;
}

export class WorkspacePolicy {
  public readonly profile = "workspace-policy-v1";
  public readonly version = "1.0.0";

  public constructor(
    private readonly workspaceFilesystem: WorkspaceFilesystem,
  ) {}

  public computeFingerprint(): string {
    const canonical = JSON.stringify({
      profile: this.profile,
      version: this.version,
      protectedPatterns: [
        ".git",
        ".ssh",
        ".env*",
        "*.pem",
        "*.key",
        "id_rsa",
        "id_ed25519",
      ],
      defaultWriteDecision: "require-approval",
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  public evaluateVisibility(tools: ToolDescriptor[]): ToolDescriptor[] {
    return tools.filter((tool) =>
      [
        "workspace.list",
        "workspace.read_text",
        "workspace.write_text",
      ].includes(tool.name),
    );
  }

  public async evaluateInvocation(
    tool: ToolDescriptor,
    rawArgs: Record<string, unknown>,
    workspaceRoot: string,
  ): Promise<InvocationPolicyResult> {
    const baseResult = {
      policyProfile: this.profile,
      policyVersion: this.version,
      policyConstraints: {},
      redactionMetadata: {},
    };

    const rawTargetPath = rawArgs["path"];
    if (typeof rawTargetPath !== "string") {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Path argument must be a non-empty string",
      };
    }
    let normalizedRel: string;
    try {
      normalizedRel = normalizeWorkspaceTarget(rawTargetPath);
    } catch {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Workspace path is not safely contained",
      };
    }

    // Protected path patterns
    const segments = normalizedRel.split(/[/\\]/);
    for (const segment of segments) {
      const lower = segment.toLowerCase();
      if (
        lower === ".git" ||
        lower === ".ssh" ||
        lower === ".env" ||
        lower.startsWith(".env.") ||
        lower === "id_rsa" ||
        lower === "id_ed25519" ||
        lower.endsWith(".pem") ||
        lower.endsWith(".key")
      ) {
        return {
          ...baseResult,
          decision: "deny",
          reason: `Protected path component '${segment}' rejected`,
        };
      }
    }

    try {
      await this.workspaceFilesystem.preflight(
        workspaceRoot,
        normalizedRel,
        operationForTool(tool.name, rawArgs),
      );
    } catch {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Workspace path failed containment safety checks",
      };
    }

    if (tool.effectClassification === "side-effecting") {
      return {
        ...baseResult,
        decision: "require-approval",
        reason: "Side-effecting tool requires allow-once approval",
        targetPath: normalizedRel,
      };
    }

    return {
      ...baseResult,
      decision: "allow",
      reason: "Read-only tool path permitted",
      targetPath: normalizedRel,
    };
  }
}

function operationForTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
): WorkspaceOperation {
  if (toolName === "workspace.list") return "list";
  if (toolName === "workspace.read_text") return "read";
  return rawArgs["mode"] === "write" ? "write" : "create";
}
