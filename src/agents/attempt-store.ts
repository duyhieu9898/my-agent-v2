import type { AppDatabase } from "../storage/database.js";
export class SqliteAttemptStore {
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
