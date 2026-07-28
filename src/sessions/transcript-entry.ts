export type TranscriptEntry =
  | {
      type: "message";
      id: string;
      parentId?: string;
      role: "user" | "assistant";
      text: string;
      createdAt: string;
      continuationRequired?: boolean;
      modelCallId?: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
    }
  | {
      type: "tool-call";
      id: string;
      parentId?: string;
      modelCallId: string;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      ordinal: number;
      createdAt: string;
    }
  | {
      type: "tool-result";
      id: string;
      parentId?: string;
      toolCallId: string;
      toolName: string;
      content: unknown;
      createdAt: string;
    };

export type PersistedTranscriptEntry = TranscriptEntry & {
  sequence: number;
};

export type TranscriptContinuation = {
  version: string;
  payload: Uint8Array;
  providerId?: string;
  modelId?: string;
  modelCallId?: string;
};

export type TranscriptAppendEntry = TranscriptEntry & {
  continuation?: TranscriptContinuation;
};

export function validateCompleteExchangeGroups(
  entries: readonly PersistedTranscriptEntry[],
): void {
  let expectedRole: "user" | "assistant" | "tool" = "user";

  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.role === "user") {
        expectedRole = "assistant";
      } else {
        expectedRole = "user";
      }
    } else if (entry.type === "tool-call") {
      expectedRole = "tool";
    } else if (entry.type === "tool-result") {
      expectedRole = "user";
    }
  }

  if (entries.length > 0 && expectedRole !== "user") {
    throw new Error("Transcript ends with an incomplete exchange group");
  }
}
