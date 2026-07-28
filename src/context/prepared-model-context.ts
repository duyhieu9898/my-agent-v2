import { createHash } from "node:crypto";
import { AppError } from "../core/errors.js";
import type { ModelToolDefinition, ModelTurn } from "../models/contracts.js";
import type { PersistedTranscriptEntry } from "../sessions/transcript-entry.js";
import { validateCompleteExchangeGroups } from "../sessions/transcript-entry.js";
import type { ToolDescriptor } from "../tools/contracts.js";

export type ContextManifest = Readonly<{
  profile: "main-v1";
  sources: readonly Readonly<{
    id: string;
    role: "user" | "assistant" | "tool";
    sequence: number;
    provenance: "local-transcript" | "run-input";
    authority: "user" | "assistant" | "system";
    trust: "direct";
    stability: "immutable";
    budgetClass: "required";
    bytes: number;
    hash: string;
  }>[];
  toolsHash?: string;
}>;

export type PreparedModelContext = Readonly<{
  promptProfile: "main-v1";
  manifestHash: string;
  instructions: readonly string[];
  turns: readonly ModelTurn[];
  tools?: readonly ModelToolDefinition[];
  manifest: ContextManifest;
  promptPlan: Readonly<{
    profile: "main-v1";
    sections: readonly (
      "instructions" | "tools" | "history" | "current-input"
    )[];
  }>;
  continuations: readonly Readonly<{
    providerId: "gemini-developer";
    modelId: "gemini-3.5-flash";
    modelCallId: string;
    version: "gemini-thought-signature-v1";
    payload: Uint8Array;
  }>[];
}>;

export function prepareModelContext(input: {
  history: readonly PersistedTranscriptEntry[];
  input: string;
  tools?: readonly ToolDescriptor[];
  continuations?: PreparedModelContext["continuations"];
  promptProfile?: "main-v1";
}): PreparedModelContext {
  const promptProfile = input.promptProfile ?? "main-v1";
  try {
    validateCompleteExchangeGroups(input.history);
  } catch (error) {
    throw new AppError(
      "MODEL_HISTORY_INCOMPATIBLE",
      "Transcript history is incomplete",
      error,
    );
  }

  const turns: ModelTurn[] = [];

  for (const entry of input.history) {
    if (entry.type === "message") {
      turns.push({
        role: entry.role,
        text: entry.text,
      });
    } else if (entry.type === "tool-call") {
      turns.push({
        role: "assistant",
        toolCalls: [
          {
            id: entry.toolCallId,
            name: entry.toolName,
            arguments: entry.arguments,
          },
        ],
      });
    } else if (entry.type === "tool-result") {
      turns.push({
        role: "tool",
        toolResults: [
          {
            id: entry.toolCallId,
            name: entry.toolName,
            result: entry.content,
          },
        ],
      });
    }
  }

  if (
    input.input &&
    !input.history.some(
      (e) =>
        e.type === "message" && e.role === "user" && e.text === input.input,
    )
  ) {
    turns.push({ role: "user", text: input.input });
  }

  const modelTools: ModelToolDefinition[] | undefined =
    input.tools && input.tools.length > 0
      ? input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.argumentSchema as Record<string, unknown>,
        }))
      : undefined;

  const toolsHash = modelTools
    ? createHash("sha256").update(JSON.stringify(modelTools)).digest("hex")
    : undefined;

  const manifest: ContextManifest = Object.freeze({
    profile: "main-v1",
    sources: Object.freeze([
      ...input.history.map((entry) =>
        source(
          entry.id,
          entry.type === "message"
            ? entry.role
            : entry.type === "tool-call"
              ? "assistant"
              : "tool",
          entry.sequence,
          "local-transcript",
          JSON.stringify(entry),
        ),
      ),
      source("run-input", "user", 0, "run-input", input.input),
    ]),
    ...(toolsHash ? { toolsHash } : {}),
  });

  return Object.freeze({
    promptProfile,
    manifestHash: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    instructions: Object.freeze(["You are the primary my-agent-v2 assistant."]),
    turns: Object.freeze(turns),
    ...(modelTools ? { tools: Object.freeze(modelTools) } : {}),
    manifest,
    promptPlan: Object.freeze({
      profile: promptProfile,
      sections: Object.freeze([
        "instructions" as const,
        ...(modelTools ? ["tools" as const] : []),
        "history" as const,
        "current-input" as const,
      ]),
    }),
    continuations: Object.freeze([...(input.continuations ?? [])]),
  });
}

function source(
  id: string,
  role: "user" | "assistant" | "tool",
  sequence: number,
  provenance: "local-transcript" | "run-input",
  text: string,
) {
  return {
    id,
    role,
    sequence,
    provenance,
    bytes: Buffer.byteLength(text),
    hash: createHash("sha256").update(text).digest("hex"),
    authority:
      role === "user"
        ? ("user" as const)
        : role === "assistant"
          ? ("assistant" as const)
          : ("system" as const),
    trust: "direct" as const,
    stability: "immutable" as const,
    budgetClass: "required" as const,
  };
}
