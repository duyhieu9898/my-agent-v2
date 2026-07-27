import { AppError } from "../core/errors.js";
import type {
  PersistedTranscriptEntry,
  TranscriptContinuation,
} from "./transcript-entry.js";
import type { TranscriptStore } from "./transcript-store.js";

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly transcripts = new Map<string, PersistedTranscriptEntry[]>();
  private readonly continuations = new Map<string, TranscriptContinuation>();

  async appendBatch(input: Parameters<TranscriptStore["appendBatch"]>[0]) {
    const existing = this.transcripts.get(input.sessionId) ?? [];
    const tail = existing.at(-1)?.sequence ?? 0;

    if (tail !== input.expectedTailSequence) {
      throw new AppError("TRANSCRIPT_TAIL_CONFLICT", "Transcript tail changed");
    }

    const appended = input.entries.map((entry, index) => {
      const { continuation, ...entryWithoutContinuation } = entry;
      const persisted: PersistedTranscriptEntry = {
        ...entryWithoutContinuation,
        sequence: tail + index + 1,
      };

      if (continuation) {
        this.continuations.set(
          `${input.sessionId}:${persisted.sequence}`,
          continuation,
        );
      }

      return persisted;
    });

    this.transcripts.set(input.sessionId, [...existing, ...appended]);
    return appended;
  }

  async readPage(
    sessionId: string,
    options: { afterSequence?: number; limit?: number; cursor?: string } = {},
  ) {
    const cursorSequence = options.cursor
      ? parseTranscriptCursor(options.cursor, sessionId)
      : undefined;
    const afterSequence = cursorSequence ?? options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const available = (this.transcripts.get(sessionId) ?? []).filter(
      (entry) => entry.sequence > afterSequence,
    );
    const entries = available.slice(0, limit);
    const last = entries.at(-1);

    return {
      entries,
      ...(last && available.length > entries.length
        ? { nextCursor: createTranscriptCursor(sessionId, last.sequence) }
        : {}),
    };
  }

  async readContinuation(sessionId: string, sequence: number) {
    return this.continuations.get(`${sessionId}:${sequence}`);
  }
}

export function createTranscriptCursor(
  sessionId: string,
  sequence: number,
): string {
  return Buffer.from(JSON.stringify({ v: 1, sessionId, sequence })).toString(
    "base64url",
  );
}

export function parseTranscriptCursor(
  cursor: string,
  sessionId: string,
): number {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { v?: number; sessionId?: string; sequence?: number };
    if (
      value.v !== 1 ||
      value.sessionId !== sessionId ||
      !Number.isInteger(value.sequence)
    ) {
      throw new Error();
    }
    return value.sequence as number;
  } catch {
    throw new AppError(
      "TRANSCRIPT_CURSOR_INVALID",
      "Transcript cursor is invalid",
    );
  }
}
