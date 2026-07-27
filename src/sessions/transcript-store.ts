import type {
  PersistedTranscriptEntry,
  TranscriptAppendEntry,
  TranscriptContinuation,
} from "./transcript-entry.js";

export type AppendTranscriptBatchInput = {
  sessionId: string;
  expectedTailSequence: number;
  entries: readonly TranscriptAppendEntry[];
};

export type TranscriptPage = {
  entries: readonly PersistedTranscriptEntry[];
  nextCursor?: string;
};

export interface TranscriptStore {
  appendBatch(
    input: AppendTranscriptBatchInput,
  ): Promise<readonly PersistedTranscriptEntry[]>;

  readPage(
    sessionId: string,
    options?: { afterSequence?: number; limit?: number; cursor?: string },
  ): Promise<TranscriptPage>;

  readContinuation(
    sessionId: string,
    sequence: number,
  ): Promise<TranscriptContinuation | undefined>;
}
