import type { PersistedTranscriptEntry } from "../sessions/transcript-entry.js";
import { validateCompleteExchangeGroups } from "../sessions/transcript-entry.js";
import { AppError } from "../core/errors.js";
import { createHash } from "node:crypto";

export type ContextManifest = Readonly<{
  profile: "main-v1";
  sources: readonly Readonly<{
    id: string;
    role: "user" | "assistant";
    sequence: number;
    provenance: "local-transcript" | "run-input";
    authority: "user" | "assistant";
    trust: "direct";
    stability: "immutable";
    budgetClass: "required";
    bytes: number;
    hash: string;
  }>[];
}>;

export type PreparedModelContext = Readonly<{
  promptProfile: "main-v1";
  manifestHash: string;
  instructions: readonly string[];
  turns: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  manifest: ContextManifest;
  promptPlan: Readonly<{
    profile: "main-v1";
    sections: readonly ("instructions" | "history" | "current-input")[];
  }>;
}>;

export function prepareModelContext(input: {
  history: readonly PersistedTranscriptEntry[];
  input: string;
}): PreparedModelContext {
  try {
    validateCompleteExchangeGroups(input.history);
  } catch (error) {
    throw new AppError(
      "MODEL_HISTORY_INCOMPATIBLE",
      "Transcript history is incomplete",
      error,
    );
  }
  const historyTurns = input.history
    .filter(
      (entry): entry is PersistedTranscriptEntry & { type: "message" } =>
        entry.type === "message",
    )
    .map((entry): { role: "user" | "assistant"; text: string } => ({
      role: entry.role,
      text: entry.text,
    }));
  const turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }> = [
    ...historyTurns,
    { role: "user", text: input.input },
  ];
  const manifest: ContextManifest = Object.freeze({
    profile: "main-v1",
    sources: Object.freeze([
      ...input.history
        .filter(
          (entry): entry is PersistedTranscriptEntry & { type: "message" } =>
            entry.type === "message",
        )
        .map((entry) =>
          source(
            entry.id,
            entry.role,
            entry.sequence,
            "local-transcript",
            entry.text,
          ),
        ),
      source("run-input", "user", 0, "run-input", input.input),
    ]),
  });
  return Object.freeze({
    promptProfile: "main-v1",
    manifestHash: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    instructions: Object.freeze(["You are the primary my-agent-v2 assistant."]),
    turns: Object.freeze(turns),
    manifest,
    promptPlan: Object.freeze({
      profile: "main-v1",
      sections: Object.freeze([
        "instructions" as const,
        "history" as const,
        "current-input" as const,
      ]),
    }),
  });
}
function source(
  id: string,
  role: "user" | "assistant",
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
    authority: role,
    trust: "direct" as const,
    stability: "immutable" as const,
    budgetClass: "required" as const,
  };
}
