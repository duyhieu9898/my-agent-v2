import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../core/errors.js";
import type { ToolDescriptor } from "../tools/contracts.js";

export type PolicyDecisionType = "allow" | "deny" | "require-approval";

export interface InvocationPolicyResult {
  decision: PolicyDecisionType;
  reason: string;
  policyProfile: string;
  policyVersion: string;
  targetPath?: string;
}

export class WorkspacePolicy {
  public readonly profile = "workspace-policy-v1";
  public readonly version = "1.0.0";

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
    };

    const targetPath = rawArgs["path"];
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Path argument must be a non-empty string",
      };
    }

    // Check NUL/control characters
    for (let i = 0; i < targetPath.length; i++) {
      const code = targetPath.charCodeAt(i);
      if (code <= 31 || code === 127) {
        return {
          ...baseResult,
          decision: "deny",
          reason: "Control-character path injection rejected",
        };
      }
    }

    // Check absolute path
    if (path.isAbsolute(targetPath)) {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Absolute paths not permitted",
      };
    }

    const normalizedRel = path.normalize(targetPath);
    if (normalizedRel.startsWith("..") || path.isAbsolute(normalizedRel)) {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Path traversal out of workspace rejected",
      };
    }

    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const resolvedFullPath = path.resolve(resolvedWorkspaceRoot, normalizedRel);

    if (!resolvedFullPath.startsWith(resolvedWorkspaceRoot)) {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Resolved path escapes workspace root",
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

    // Symlink escape check
    try {
      let current = resolvedWorkspaceRoot;
      for (const segment of segments) {
        current = path.join(current, segment);
        if (fs.existsSync(current)) {
          const lstat = await fs.promises.lstat(current);
          if (lstat.isSymbolicLink()) {
            const real = await fs.promises.realpath(current);
            if (!real.startsWith(resolvedWorkspaceRoot)) {
              return {
                ...baseResult,
                decision: "deny",
                reason: "Symlink points outside workspace root",
              };
            }
          }
        }
      }
    } catch {
      return {
        ...baseResult,
        decision: "deny",
        reason: "Failed path safety check during resolution",
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
