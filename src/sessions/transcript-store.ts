import type { TranscriptEntry } from "./transcript-entry.js";

export interface TranscriptStore {
  append(
    sessionId: string,
    entry: TranscriptEntry,
  ): Promise<void>;

  read(sessionId: string): Promise<TranscriptEntry[]>;

  clear(sessionId: string): Promise<void>;
}
