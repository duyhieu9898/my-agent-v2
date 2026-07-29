import { Type, type TSchema } from "typebox";
import type {
  AgentId,
  AttemptId,
  ModelCallId,
  RunId,
  SessionId,
  SessionKey,
  ToolCallId,
} from "../core/identities.js";

export type ToolEffectClassification = "read-only" | "side-effecting";
export type ToolSensitivityClassification = "none" | "sensitive";
export type ToolConcurrencyTrait = "parallel-safe" | "sequential";

export interface ToolExecutionContext {
  agentId: AgentId;
  workspaceRoot: string;
  targetPath: string;
  toolCallId: ToolCallId;
  deadline?: number;
  signal?: AbortSignal;
  inputLimits: { maxBytes?: number };
  outputLimits: { maxBytes?: number };
  policyConstraints: Record<string, unknown>;
  sandboxProfile: string;
}

export interface ToolDescriptor<TArgs = any, TResult = any> {
  name: string;
  descriptorVersion: string;
  owningModule: string;
  description: string;
  argumentSchema: TSchema;
  resultSchema: TSchema;
  effectClassification: ToolEffectClassification;
  sensitivityClassification: ToolSensitivityClassification;
  executionTarget: string;
  sandboxRequirement: string;
  timeoutMs: number;
  cancellationSupport: boolean;
  concurrencyTrait: ToolConcurrencyTrait;
  idempotencyTrait: boolean;
  approvalSummaryRenderer: (args: TArgs) => string;
  redactionRules: string[];
  inputLimits: { maxBytes?: number };
  outputLimits: { maxBytes?: number };
  progressFingerprintVersion: string;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<TResult>;
}

export type TerminalToolState =
  | "not-started"
  | "completed"
  | "failed-before-known-side-effect"
  | "cancelled-with-no-known-side-effect"
  | "outcome-uncertain";

export interface NormalizedToolRequest {
  toolCallId: ToolCallId;
  providerCallId?: string;
  modelCallId: ModelCallId;
  ordinal: number;
  toolName: string;
  rawArguments: Record<string, unknown>;
}

export interface NormalizedToolOutcome {
  toolCallId: ToolCallId;
  toolName: string;
  ordinal: number;
  terminalState: TerminalToolState;
  ok: boolean;
  normalizedArguments?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  durationMs: number;
}

// Schemas for Workspace Tools
export const WorkspaceListArgsSchema = Type.Object(
  {
    path: Type.String({ description: "Relative path inside workspace" }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        description: "Maximum entries to return",
      }),
    ),
  },
  { additionalProperties: false },
);

export const WorkspaceListResultSchema = Type.Object(
  {
    path: Type.String(),
    entries: Type.Array(
      Type.Object({
        name: Type.String(),
        kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
      }),
    ),
    returnedCount: Type.Integer(),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceReadTextArgsSchema = Type.Object(
  {
    path: Type.String({ description: "Relative path inside workspace" }),
    offsetBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const WorkspaceReadTextResultSchema = Type.Object(
  {
    path: Type.String(),
    offsetBytes: Type.Integer(),
    bytesRead: Type.Integer(),
    fileSizeBytes: Type.Integer(),
    eof: Type.Boolean(),
    text: Type.String(),
    chunkHash: Type.String(),
  },
  { additionalProperties: false },
);

export const WorkspaceWriteTextArgsSchema = Type.Object(
  {
    path: Type.String({ description: "Relative path inside workspace" }),
    content: Type.String({ description: "UTF-8 content to write" }),
    mode: Type.Union([Type.Literal("create"), Type.Literal("replace")]),
  },
  { additionalProperties: false },
);

export const WorkspaceWriteTextResultSchema = Type.Object(
  {
    path: Type.String(),
    mode: Type.Union([Type.Literal("create"), Type.Literal("replace")]),
    bytesWritten: Type.Integer(),
    priorState: Type.Union([Type.Literal("none"), Type.Literal("existed")]),
    previousHash: Type.Optional(Type.String()),
    resultingHash: Type.String(),
  },
  { additionalProperties: false },
);
