import { createHash } from "node:crypto";

import type { WorkspaceFilesystem } from "./workspace-filesystem.js";
import {
  WorkspaceListArgsSchema,
  WorkspaceListResultSchema,
  WorkspaceReadTextArgsSchema,
  WorkspaceReadTextResultSchema,
  WorkspaceWriteTextArgsSchema,
  WorkspaceWriteTextResultSchema,
  type ToolRegistration,
} from "./contracts.js";

export function createWorkspaceListTool(
  workspaceFilesystem: WorkspaceFilesystem,
): ToolRegistration {
  return {
    name: "workspace.list",
    descriptorVersion: "1.0.0",
    owningModule: "workspace-tools",
    description:
      "Bounded directory listing within the agent workspace. Returns sorted entries.",
    argumentSchema: WorkspaceListArgsSchema,
    resultSchema: WorkspaceListResultSchema,
    effectClassification: "read-only",
    sensitivityClassification: "none",
    executionTarget: "workspace",
    sandboxRequirement: "host-workspace-v1",
    timeoutMs: 10000,
    cancellationSupport: true,
    concurrencyTrait: "parallel-safe",
    idempotencyTrait: true,
    approvalSummaryRendererVersion: "1.0.0",
    approvalSummaryRenderer: (args: { path: string }) =>
      `List workspace directory: ${args.path}`,
    redactionRules: [],
    inputLimits: { maxBytes: 1024 },
    outputLimits: { maxBytes: 65536 },
    progressFingerprintVersion: "1.0.0",
    execute: async (args: { path: string; limit?: number }, context) => {
      const entries = await workspaceFilesystem.list(
        context.workspaceRoot,
        context.targetPath,
      );
      entries.sort((a, b) => a.name.localeCompare(b.name));

      const limit = Math.min(args.limit ?? 200, 200);
      const sliced = entries.slice(0, limit);
      return {
        path: context.targetPath,
        entries: sliced,
        returnedCount: sliced.length,
        hasMore: entries.length > limit,
      };
    },
  };
}

export function createWorkspaceReadTextTool(
  workspaceFilesystem: WorkspaceFilesystem,
): ToolRegistration {
  return {
    name: "workspace.read_text",
    descriptorVersion: "1.0.0",
    owningModule: "workspace-tools",
    description:
      "Bounded UTF-8 text file read within the workspace with offset and byte limits.",
    argumentSchema: WorkspaceReadTextArgsSchema,
    resultSchema: WorkspaceReadTextResultSchema,
    effectClassification: "read-only",
    sensitivityClassification: "none",
    executionTarget: "workspace",
    sandboxRequirement: "host-workspace-v1",
    timeoutMs: 10000,
    cancellationSupport: true,
    concurrencyTrait: "parallel-safe",
    idempotencyTrait: true,
    approvalSummaryRendererVersion: "1.0.0",
    approvalSummaryRenderer: (args: { path: string }) =>
      `Read workspace file: ${args.path}`,
    redactionRules: [],
    inputLimits: { maxBytes: 1024 },
    outputLimits: { maxBytes: 65536 },
    progressFingerprintVersion: "1.0.0",
    execute: async (
      args: { path: string; offsetBytes?: number; maxBytes?: number },
      context,
    ) => {
      const offsetBytes = Math.max(0, args.offsetBytes ?? 0);
      const maxBytes = Math.min(args.maxBytes ?? 65536, 65536);
      const chunk = await workspaceFilesystem.readTextChunk(
        context.workspaceRoot,
        context.targetPath,
        offsetBytes,
        maxBytes,
      );
      const eof = offsetBytes + chunk.bytesRead >= chunk.fileSizeBytes;

      return {
        path: context.targetPath,
        offsetBytes,
        bytesRead: chunk.bytesRead,
        fileSizeBytes: chunk.fileSizeBytes,
        eof,
        text: chunk.text,
        chunkHash: createHash("sha256").update(chunk.text).digest("hex"),
      };
    },
  };
}

export function createWorkspaceWriteTextTool(
  workspaceFilesystem: WorkspaceFilesystem,
): ToolRegistration {
  return {
    name: "workspace.write_text",
    descriptorVersion: "1.0.0",
    owningModule: "workspace-tools",
    description:
      "Atomic create or write of a bounded UTF-8 text file within the workspace.",
    argumentSchema: WorkspaceWriteTextArgsSchema,
    resultSchema: WorkspaceWriteTextResultSchema,
    effectClassification: "side-effecting",
    sensitivityClassification: "none",
    executionTarget: "workspace",
    sandboxRequirement: "host-workspace-v1",
    timeoutMs: 15000,
    cancellationSupport: true,
    concurrencyTrait: "sequential",
    idempotencyTrait: false,
    approvalSummaryRendererVersion: "1.0.0",
    approvalSummaryRenderer: (args: {
      path: string;
      mode: "create" | "write";
      content: string;
    }) => {
      const bytes = Buffer.byteLength(args.content ?? "", "utf8");
      const hash = createHash("sha256")
        .update(args.content ?? "")
        .digest("hex")
        .slice(0, 8);
      return `Write file '${args.path}' (mode=${args.mode}, ${bytes} bytes, hash=${hash})`;
    },
    redactionRules: [],
    inputLimits: { maxBytes: 65536 },
    outputLimits: { maxBytes: 65536 },
    progressFingerprintVersion: "1.0.0",
    execute: async (
      args: { path: string; content: string; mode: "create" | "write" },
      context,
    ) => {
      let priorState: "none" | "existed" = "none";
      let previousHash: string | undefined;
      if (args.mode === "write") {
        try {
          const existing = await workspaceFilesystem.readTextChunk(
            context.workspaceRoot,
            context.targetPath,
            0,
            65536,
          );
          priorState = "existed";
          previousHash = createHash("sha256")
            .update(existing.text)
            .digest("hex");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "TOOL_IMPLEMENTATION_FAILED"
          ) {
            throw error;
          }
        }
        await workspaceFilesystem.writeText(
          context.workspaceRoot,
          context.targetPath,
          args.content,
        );
      } else {
        await workspaceFilesystem.createText(
          context.workspaceRoot,
          context.targetPath,
          args.content,
        );
      }

      const bytesWritten = Buffer.byteLength(args.content, "utf8");
      const resultingHash = createHash("sha256")
        .update(args.content)
        .digest("hex");
      return {
        path: context.targetPath,
        mode: args.mode,
        bytesWritten,
        priorState,
        ...(previousHash ? { previousHash } : {}),
        resultingHash,
      };
    },
  };
}
