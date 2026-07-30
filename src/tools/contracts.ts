import { AppError } from "../core/errors.js";
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
  /** Implementation-owned lifecycle markers supplied by Tool Runtime. */
  markIoStarted(): void;
  markSideEffectPossible(): void;
}

export interface ToolDescriptor {
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
  approvalSummaryRendererVersion?: string;
  redactionRules: string[];
  inputLimits: { maxBytes?: number };
  outputLimits: { maxBytes?: number };
  progressFingerprintVersion: string;
}

export interface ToolRegistration<
  TArgs = any,
  TResult = any,
> extends ToolDescriptor {
  approvalSummaryRenderer: (args: TArgs) => string;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<TResult>;
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (
      val !== null &&
      (typeof val === "object" || typeof val === "function")
    ) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function strictJsonSnapshot<T>(
  val: T,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (val === null) {
    return null as T;
  }
  const type = typeof val;
  if (type === "boolean" || type === "string") {
    return val;
  }
  if (type === "number") {
    if (!Number.isFinite(val as number)) {
      throw new AppError(
        "TOOL_ARGUMENTS_INVALID",
        `Non-finite number '${String(val)}' is rejected in strict JSON`,
      );
    }
    return val;
  }
  if (
    type === "undefined" ||
    type === "symbol" ||
    type === "function" ||
    type === "bigint"
  ) {
    throw new AppError(
      "TOOL_ARGUMENTS_INVALID",
      `Type '${type}' is rejected in strict JSON`,
    );
  }
  if (type === "object") {
    if (seen.has(val as unknown as object)) {
      throw new AppError(
        "TOOL_ARGUMENTS_INVALID",
        "Cyclic object references are rejected in strict JSON",
      );
    }
    seen.add(val as unknown as object);

    try {
      if (Array.isArray(val)) {
        const clonedArr = val.map((item) => strictJsonSnapshot(item, seen));
        return Object.freeze(clonedArr) as unknown as T;
      }

      const proto = Object.getPrototypeOf(val);
      if (proto !== null && proto !== Object.prototype) {
        throw new AppError(
          "TOOL_ARGUMENTS_INVALID",
          "Non-plain mutable class instances are rejected in strict JSON",
        );
      }

      if (Object.getOwnPropertySymbols(val as object).length > 0) {
        throw new AppError(
          "TOOL_ARGUMENTS_INVALID",
          "Symbol object keys are rejected in strict JSON",
        );
      }

      const keys = Object.keys(val as object);
      const clonedObj: Record<string, unknown> = {};
      for (const k of keys) {
        const propVal = (val as any)[k];
        if (propVal === undefined) {
          throw new AppError(
            "TOOL_ARGUMENTS_INVALID",
            `Property '${k}' with value 'undefined' is rejected in strict JSON`,
          );
        }
        clonedObj[k] = strictJsonSnapshot(propVal, seen);
      }
      return Object.freeze(clonedObj) as unknown as T;
    } finally {
      seen.delete(val as unknown as object);
    }
  }

  throw new AppError(
    "TOOL_ARGUMENTS_INVALID",
    `Unsupported value '${String(val)}' in strict JSON`,
  );
}

export function canonicalJsonStringify(val: unknown): string {
  const snapshot = strictJsonSnapshot(val);
  return stringifyCanonical(snapshot);
}

function stringifyCanonical(val: unknown): string {
  if (
    val === null ||
    typeof val === "boolean" ||
    typeof val === "number" ||
    typeof val === "string"
  ) {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(stringifyCanonical).join(",")}]`;
  }
  if (typeof val === "object") {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${stringifyCanonical((val as any)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new AppError(
    "TOOL_ARGUMENTS_INVALID",
    `Unsupported JSON value: ${String(val)}`,
  );
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
    causeCode?: string;
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
    mode: Type.Union([Type.Literal("create"), Type.Literal("write")]),
  },
  { additionalProperties: false },
);

export const WorkspaceWriteTextResultSchema = Type.Object(
  {
    path: Type.String(),
    mode: Type.Union([Type.Literal("create"), Type.Literal("write")]),
    bytesWritten: Type.Integer(),
    priorState: Type.Union([Type.Literal("none"), Type.Literal("existed")]),
    previousHash: Type.Optional(Type.String()),
    resultingHash: Type.String(),
  },
  { additionalProperties: false },
);
