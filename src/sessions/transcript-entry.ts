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
