import type { AppDatabase } from "../storage/database.js";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunRecord = {
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  status: RunStatus;
  inputText: string;
  createdAt: string;
  updatedAt: string;
  terminalCode?: string;
};
export class SqliteRunStore {
  public constructor(private readonly database: AppDatabase) {}
  async create(run: RunRecord): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO runs (run_id, agent_id, session_key, session_id, status, input_text, created_at, updated_at, terminal_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.runId,
        run.agentId,
        run.sessionKey,
        run.sessionId,
        run.status,
        run.inputText,
        run.createdAt,
        run.updatedAt,
        run.terminalCode ?? null,
      );
  }
  async get(runId: string): Promise<RunRecord | undefined> {
    const row = this.database
      .prepare(
        "SELECT run_id, agent_id, session_key, session_id, status, input_text, created_at, updated_at, terminal_code FROM runs WHERE run_id = ?",
      )
      .get(runId) as any;
    return row
      ? {
          runId: row.run_id,
          agentId: row.agent_id,
          sessionKey: row.session_key,
          sessionId: row.session_id,
          status: row.status,
          inputText: row.input_text,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(row.terminal_code ? { terminalCode: row.terminal_code } : {}),
        }
      : undefined;
  }
  async updateStatus(
    runId: string,
    status: RunStatus,
    updatedAt: string,
    terminalCode?: string,
  ): Promise<void> {
    this.database
      .prepare(
        "UPDATE runs SET status = ?, updated_at = ?, terminal_code = ? WHERE run_id = ?",
      )
      .run(status, updatedAt, terminalCode ?? null, runId);
  }
}
