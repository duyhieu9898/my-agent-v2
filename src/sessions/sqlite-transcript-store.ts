import { AppError, normalizeStorageError } from "../core/errors.js";
import type { AppDatabase } from "../storage/database.js";
import {
  createTranscriptCursor,
  parseTranscriptCursor,
} from "./in-memory-transcript-store.js";
import type {
  PersistedTranscriptEntry,
  TranscriptContinuation,
  TranscriptEntry,
} from "./transcript-entry.js";
import type { TranscriptStore } from "./transcript-store.js";

type TranscriptRow = {
  sequence: number;
  entry_id: string;
  entry_type: "message" | "tool-result";
  parent_id: string | null;
  role: "user" | "assistant" | null;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_content_json: string | null;
  created_at: string;
  continuation_required: number;
  model_call_id: string | null;
};

function mapEntry(row: TranscriptRow): PersistedTranscriptEntry {
  const common = {
    sequence: row.sequence,
    id: row.entry_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    createdAt: row.created_at,
  };

  if (row.entry_type === "message") {
    if (!row.role || row.text_content === null) {
      throw new AppError("STORAGE_UNAVAILABLE", "Stored message is malformed");
    }
    return {
      ...common,
      type: "message",
      role: row.role,
      text: row.text_content,
      ...(row.continuation_required ? { continuationRequired: true } : {}),
      ...(row.model_call_id ? { modelCallId: row.model_call_id } : {}),
    };
  }

  if (!row.tool_call_id || !row.tool_name || row.tool_content_json === null) {
    throw new AppError(
      "STORAGE_UNAVAILABLE",
      "Stored tool result is malformed",
    );
  }
  return {
    ...common,
    type: "tool-result",
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    content: JSON.parse(row.tool_content_json),
  };
}

function entryColumns(entry: TranscriptEntry): {
  entryType: string;
  parentId: string | null;
  role: string | null;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolContentJson: string | null;
  continuationRequired: number;
  modelCallId: string | null;
} {
  if (entry.type === "message") {
    return {
      entryType: entry.type,
      parentId: entry.parentId ?? null,
      role: entry.role,
      textContent: entry.text,
      toolCallId: null,
      toolName: null,
      toolContentJson: null,
      continuationRequired: entry.continuationRequired ? 1 : 0,
      modelCallId: entry.modelCallId ?? null,
    };
  }
  return {
    entryType: entry.type,
    parentId: entry.parentId ?? null,
    role: null,
    textContent: null,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    toolContentJson: JSON.stringify(entry.content),
    continuationRequired: 0,
    modelCallId: null,
  };
}

export class SqliteTranscriptStore implements TranscriptStore {
  public constructor(private readonly database: AppDatabase) {}

  async appendBatch(input: Parameters<TranscriptStore["appendBatch"]>[0]) {
    try {
      return this.database.transaction(() => {
        const tail = this.database
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM transcript_entries WHERE session_id = ?",
          )
          .get(input.sessionId) as { sequence: number };
        if (tail.sequence !== input.expectedTailSequence) {
          throw new AppError(
            "TRANSCRIPT_TAIL_CONFLICT",
            "Transcript tail changed",
          );
        }

        const insertEntry = this.database.prepare(`
          INSERT INTO transcript_entries (
            session_id, sequence, entry_id, entry_type, parent_id, role,
            text_content, tool_call_id, tool_name, tool_content_json, created_at, continuation_required, model_call_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertContinuation = this.database.prepare(`
          INSERT INTO transcript_continuations (
            session_id, sequence, continuation_version, continuation_payload, provider_id, model_id, model_call_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        return input.entries.map((entry, index) => {
          const { continuation, ...entryWithoutContinuation } = entry;
          const sequence = tail.sequence + index + 1;
          const columns = entryColumns(entryWithoutContinuation);
          insertEntry.run(
            input.sessionId,
            sequence,
            entry.id,
            columns.entryType,
            columns.parentId,
            columns.role,
            columns.textContent,
            columns.toolCallId,
            columns.toolName,
            columns.toolContentJson,
            entry.createdAt,
            columns.continuationRequired,
            columns.modelCallId,
          );
          if (continuation) {
            insertContinuation.run(
              input.sessionId,
              sequence,
              continuation.version,
              continuation.payload,
              continuation.providerId ?? null,
              continuation.modelId ?? null,
              continuation.modelCallId ?? null,
            );
          }
          return { ...entryWithoutContinuation, sequence };
        });
      })();
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }
      throw normalizeStorageError(error);
    }
  }

  async readPage(
    sessionId: string,
    options: { afterSequence?: number; limit?: number; cursor?: string } = {},
  ) {
    const afterSequence = options.cursor
      ? parseTranscriptCursor(options.cursor, sessionId)
      : (options.afterSequence ?? 0);
    const limit = options.limit ?? 100;
    const rows = this.database
      .prepare(
        `SELECT sequence, entry_id, entry_type, parent_id, role, text_content,
          tool_call_id, tool_name, tool_content_json, created_at, continuation_required, model_call_id
         FROM transcript_entries
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit + 1) as TranscriptRow[];
    const hasNext = rows.length > limit;
    const entries = rows.slice(0, limit).map(mapEntry);
    const last = entries.at(-1);
    return {
      entries,
      ...(hasNext && last
        ? { nextCursor: createTranscriptCursor(sessionId, last.sequence) }
        : {}),
    };
  }

  async readContinuation(sessionId: string, sequence: number) {
    const row = this.database
      .prepare(
        `SELECT continuation_version, continuation_payload, provider_id, model_id, model_call_id
         FROM transcript_continuations WHERE session_id = ? AND sequence = ?`,
      )
      .get(sessionId, sequence) as
      | {
          continuation_version: string;
          continuation_payload: Uint8Array;
          provider_id: string | null;
          model_id: string | null;
          model_call_id: string | null;
        }
      | undefined;
    return row
      ? {
          version: row.continuation_version,
          payload: row.continuation_payload,
          ...(row.provider_id ? { providerId: row.provider_id } : {}),
          ...(row.model_id ? { modelId: row.model_id } : {}),
          ...(row.model_call_id ? { modelCallId: row.model_call_id } : {}),
        }
      : undefined;
  }
}
