import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../core/errors.js";
import {
  WorkspaceListArgsSchema,
  WorkspaceListResultSchema,
  WorkspaceReadTextArgsSchema,
  WorkspaceReadTextResultSchema,
  WorkspaceWriteTextArgsSchema,
  WorkspaceWriteTextResultSchema,
  type ToolDescriptor,
  type ToolExecutionContext,
} from "./contracts.js";

export const workspaceListTool: ToolDescriptor = {
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
  execute: async (
    args: { path: string; limit?: number },
    context: ToolExecutionContext,
  ) => {
    const fullPath = path.resolve(context.workspaceRoot, context.targetPath);

    if (!fs.existsSync(fullPath)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Directory '${context.targetPath}' does not exist`,
      );
    }

    const stat = await fs.promises.stat(fullPath);
    if (!stat.isDirectory()) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Path '${context.targetPath}' is not a directory`,
      );
    }

    const dirents = await fs.promises.readdir(fullPath, {
      withFileTypes: true,
    });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    const limit = Math.min(args.limit ?? 200, 200);
    const hasMore = dirents.length > limit;
    const sliced = dirents.slice(0, limit);

    const entries = sliced.map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
    }));

    return {
      path: context.targetPath,
      entries,
      returnedCount: entries.length,
      hasMore,
    };
  },
};

export const workspaceReadTextTool: ToolDescriptor = {
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
    context: ToolExecutionContext,
  ) => {
    const fullPath = path.resolve(context.workspaceRoot, context.targetPath);

    if (!fs.existsSync(fullPath)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `File '${context.targetPath}' does not exist`,
      );
    }

    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Path '${context.targetPath}' is not a regular file`,
      );
    }

    const fileSizeBytes = stat.size;
    const offsetBytes = Math.max(0, args.offsetBytes ?? 0);
    const maxBytes = Math.min(args.maxBytes ?? 65536, 65536);

    if (offsetBytes >= fileSizeBytes && fileSizeBytes > 0) {
      return {
        path: context.targetPath,
        offsetBytes,
        bytesRead: 0,
        fileSizeBytes,
        eof: true,
        text: "",
        chunkHash: createHash("sha256").update("").digest("hex"),
      };
    }

    const fileHandle = await fs.promises.open(fullPath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        maxBytes,
        offsetBytes,
      );

      const readBuffer = buffer.subarray(0, bytesRead);
      const text = readBuffer.toString("utf8");
      const chunkHash = createHash("sha256").update(text).digest("hex");
      const eof = offsetBytes + bytesRead >= fileSizeBytes;

      return {
        path: context.targetPath,
        offsetBytes,
        bytesRead,
        fileSizeBytes,
        eof,
        text,
        chunkHash,
      };
    } finally {
      await fileHandle.close();
    }
  },
};

export const workspaceWriteTextTool: ToolDescriptor = {
  name: "workspace.write_text",
  descriptorVersion: "1.0.0",
  owningModule: "workspace-tools",
  description:
    "Atomic create or replace of a bounded UTF-8 text file within the workspace.",
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
    mode: "create" | "replace";
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
    args: { path: string; content: string; mode: "create" | "replace" },
    context: ToolExecutionContext,
  ) => {
    const fullPath = path.resolve(context.workspaceRoot, context.targetPath);
    const parentDir = path.dirname(fullPath);

    // No implicit parent-directory creation (Section 4.6)
    if (!fs.existsSync(parentDir)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Parent directory '${path.relative(context.workspaceRoot, parentDir)}' does not exist`,
      );
    }

    const exists = fs.existsSync(fullPath);
    let priorState: "none" | "existed" = "none";
    let previousHash: string | undefined = undefined;

    if (args.mode === "create") {
      if (exists) {
        throw new AppError(
          "TOOL_IMPLEMENTATION_FAILED",
          `File '${context.targetPath}' already exists in create mode`,
        );
      }
    } else if (args.mode === "replace") {
      if (!exists) {
        throw new AppError(
          "TOOL_IMPLEMENTATION_FAILED",
          `File '${context.targetPath}' does not exist in replace mode`,
        );
      }
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) {
        throw new AppError(
          "TOOL_IMPLEMENTATION_FAILED",
          `Path '${context.targetPath}' is not a regular file in replace mode`,
        );
      }
      priorState = "existed";
      const existingContent = await fs.promises.readFile(fullPath, "utf8");
      previousHash = createHash("sha256").update(existingContent).digest("hex");
    }

    const tempFilePath = `${fullPath}.tmp.${randomUUID()}`;
    const bytesWritten = Buffer.byteLength(args.content, "utf8");
    const resultingHash = createHash("sha256")
      .update(args.content)
      .digest("hex");

    try {
      await fs.promises.writeFile(tempFilePath, args.content, "utf8");
      await fs.promises.rename(tempFilePath, fullPath);

      return {
        path: context.targetPath,
        mode: args.mode,
        bytesWritten,
        priorState,
        ...(previousHash ? { previousHash } : {}),
        resultingHash,
      };
    } catch (error) {
      if (fs.existsSync(tempFilePath)) {
        try {
          await fs.promises.unlink(tempFilePath);
        } catch {
          // ignore cleanup error
        }
      }
      throw error;
    }
  },
};
