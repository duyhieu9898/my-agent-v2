import type { TranscriptEntry } from "./transcript-entry.js";
import type { TranscriptStore } from "./transcript-store.js";

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly transcripts =
    new Map<string, TranscriptEntry[]>();

  async append(
    sessionId: string,
    entry: TranscriptEntry,
  ): Promise<void> {
    const entries = this.transcripts.get(sessionId) ?? [];
    entries.push(entry);
    this.transcripts.set(sessionId, entries);
  }

  async read(
    sessionId: string,
  ): Promise<TranscriptEntry[]> {
    return [...(this.transcripts.get(sessionId) ?? [])];
  }

  async clear(sessionId: string): Promise<void> {
    this.transcripts.delete(sessionId);
  }
}
