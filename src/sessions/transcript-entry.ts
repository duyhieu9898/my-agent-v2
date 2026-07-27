export type TranscriptEntry =
  | {
      type: "message";
      id: string;
      parentId?: string;
      role: "user" | "assistant";
      text: string;
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
};

export type TranscriptAppendEntry = TranscriptEntry & {
  continuation?: TranscriptContinuation;
};

export function validateCompleteExchangeGroups(
  entries: readonly PersistedTranscriptEntry[],
): void {
  let expectedRole: "user" | "assistant" = "user";

  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }

    if (entry.role !== expectedRole) {
      throw new Error(
        "Transcript exchange groups must alternate user and assistant",
      );
    }

    expectedRole = expectedRole === "user" ? "assistant" : "user";
  }

  if (entries.length > 0 && expectedRole !== "user") {
    throw new Error("Transcript ends with an incomplete exchange group");
  }
}
