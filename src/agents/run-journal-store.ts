import { AppError } from "../core/errors.js";
import type { AppDatabase } from "../storage/database.js";

export type RunJournalEntry = {
  runId: string;
  sequence: number;
  eventName: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
  occurredAt: string;
};
export type RunJournalPage = {
  entries: readonly RunJournalEntry[];
  nextCursor?: string;
};
export interface RunJournalStore {
  append(input: Omit<RunJournalEntry, "sequence">): Promise<RunJournalEntry>;
  readPage(
    runId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<RunJournalPage>;
}

export class SqliteRunJournalStore implements RunJournalStore {
  public constructor(private readonly database: AppDatabase) {}
  async append(
    input: Omit<RunJournalEntry, "sequence">,
  ): Promise<RunJournalEntry> {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_journal_entries WHERE run_id = ?",
        )
        .get(input.runId) as { sequence: number };
      const entry = { ...input, sequence: row.sequence + 1 };
      this.database
        .prepare(
          "INSERT INTO run_journal_entries (run_id, sequence, event_name, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          entry.runId,
          entry.sequence,
          entry.eventName,
          JSON.stringify(entry.payload),
          entry.occurredAt,
        );
      return entry;
    })();
  }
  async readPage(
    runId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<RunJournalPage> {
    const after = options.cursor ? parseCursor(options.cursor, runId) : 0;
    const limit = options.limit ?? 100;
    const rows = this.database
      .prepare(
        "SELECT sequence, event_name, payload_json, occurred_at FROM run_journal_entries WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(runId, after, limit + 1) as Array<{
      sequence: number;
      event_name: string;
      payload_json: string;
      occurred_at: string;
    }>;
    const hasNext = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => ({
      runId,
      sequence: row.sequence,
      eventName: row.event_name,
      payload: JSON.parse(row.payload_json) as RunJournalEntry["payload"],
      occurredAt: row.occurred_at,
    }));
    const last = entries.at(-1);
    return {
      entries,
      ...(hasNext && last ? { nextCursor: cursor(runId, last.sequence) } : {}),
    };
  }
}
function cursor(runId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, runId, sequence })).toString(
    "base64url",
  );
}
function parseCursor(value: string, runId: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { v?: number; runId?: string; sequence?: number };
    if (
      parsed.v !== 1 ||
      parsed.runId !== runId ||
      !Number.isInteger(parsed.sequence)
    )
      throw new Error();
    return parsed.sequence as number;
  } catch {
    throw new AppError(
      "JOURNAL_CURSOR_INVALID",
      "Run Journal cursor is invalid",
    );
  }
}
