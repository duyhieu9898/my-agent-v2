import type { AppDatabase } from "../storage/database.js";
export interface AttemptStore {
  create(attemptId: string, runId: string, startedAt: string): Promise<void>;
  get(attemptId: string): Promise<
    | {
        attemptId: string;
        runId: string;
        status: "running" | "completed" | "failed" | "cancelled";
        terminalCode?: string;
      }
    | undefined
  >;
  terminalize(
    attemptId: string,
    status: "completed" | "failed" | "cancelled",
    endedAt: string,
    terminalCode?: string,
  ): Promise<void>;
}
export class SqliteAttemptStore implements AttemptStore {
  public constructor(private readonly database: AppDatabase) {}
  async create(
    attemptId: string,
    runId: string,
    startedAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO attempts (attempt_id, run_id, status, started_at) VALUES (?, ?, 'running', ?)",
      )
      .run(attemptId, runId, startedAt);
  }
  async get(attemptId: string) {
    const row = this.database
      .prepare(
        "SELECT attempt_id, run_id, status, terminal_code FROM attempts WHERE attempt_id = ?",
      )
      .get(attemptId) as
      | {
          attempt_id: string;
          run_id: string;
          status: "running" | "completed" | "failed" | "cancelled";
          terminal_code: string | null;
        }
      | undefined;
    return row
      ? {
          attemptId: row.attempt_id,
          runId: row.run_id,
          status: row.status,
          ...(row.terminal_code ? { terminalCode: row.terminal_code } : {}),
        }
      : undefined;
  }
  async terminalize(
    attemptId: string,
    status: "completed" | "failed" | "cancelled",
    endedAt: string,
    terminalCode?: string,
  ): Promise<void> {
    this.database
      .prepare(
        "UPDATE attempts SET status = ?, ended_at = ?, terminal_code = ? WHERE attempt_id = ?",
      )
      .run(status, endedAt, terminalCode ?? null, attemptId);
  }
}
