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
export type TerminalStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled"
>;
export type TerminalCommitPlan = Readonly<{
  runId: string;
  attemptId?: string;
  runStatus: TerminalStatus;
  attemptStatus: TerminalStatus;
  occurredAt: string;
  terminalCode?: string;
}>;
export type TerminalCommitResult =
  "committed" | "already-committed-same-outcome" | "conflict";
export type TerminalFinalizationPlan = Readonly<{
  primary: TerminalCommitPlan;
  fallback: TerminalCommitPlan;
}>;
export type TerminalCommitFaultPhase = "attempt" | "run";
export type InterruptedRunReconciliation = Readonly<{
  runId: string;
  reconciled: boolean;
  attemptsReconciled: number;
}>;
export interface RunStore {
  create(run: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | undefined>;
  updateStatus(
    runId: string,
    status: RunStatus,
    updatedAt: string,
    terminalCode?: string,
  ): Promise<void>;
  commitTerminalOutcome(
    plan: TerminalCommitPlan,
  ): Promise<TerminalCommitResult>;
}
export class SqliteRunStore implements RunStore {
  public constructor(
    private readonly database: AppDatabase,
    private readonly terminalCommitFault?: (
      phase: TerminalCommitFaultPhase,
      plan: TerminalCommitPlan,
    ) => void,
  ) {}
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
  async commitTerminalOutcome(
    plan: TerminalCommitPlan,
  ): Promise<TerminalCommitResult> {
    return this.database.transaction(() => {
      const run = this.database
        .prepare("SELECT status, terminal_code FROM runs WHERE run_id = ?")
        .get(plan.runId) as
        { status: RunStatus; terminal_code: string | null } | undefined;
      if (!run) return "conflict";
      const attempt = plan.attemptId
        ? (this.database
            .prepare(
              "SELECT status, terminal_code FROM attempts WHERE attempt_id = ?",
            )
            .get(plan.attemptId) as
            | {
                status: "running" | TerminalStatus;
                terminal_code: string | null;
              }
            | undefined)
        : undefined;
      const sameRun =
        run.status === plan.runStatus &&
        (run.terminal_code ?? undefined) === plan.terminalCode;
      const sameAttempt =
        !plan.attemptId ||
        (attempt?.status === plan.attemptStatus &&
          (attempt.terminal_code ?? undefined) === plan.terminalCode);
      if (sameRun && sameAttempt) return "already-committed-same-outcome";
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        (plan.attemptId &&
          (!attempt ||
            attempt.status === "completed" ||
            attempt.status === "failed" ||
            attempt.status === "cancelled"))
      )
        return "conflict";
      if (plan.attemptId) {
        this.terminalCommitFault?.("attempt", plan);
        this.database
          .prepare(
            "UPDATE attempts SET status = ?, ended_at = ?, terminal_code = ? WHERE attempt_id = ? AND status = 'running'",
          )
          .run(
            plan.attemptStatus,
            plan.occurredAt,
            plan.terminalCode ?? null,
            plan.attemptId,
          );
      }
      this.terminalCommitFault?.("run", plan);
      this.database
        .prepare(
          "UPDATE runs SET status = ?, updated_at = ?, terminal_code = ? WHERE run_id = ? AND status IN ('queued', 'running')",
        )
        .run(
          plan.runStatus,
          plan.occurredAt,
          plan.terminalCode ?? null,
          plan.runId,
        );
      return "committed";
    })();
  }

  async reconcileInterruptedRuns(
    occurredAt: string,
    fault?: (phase: "attempt" | "run" | "journal", runId: string) => void,
  ): Promise<readonly InterruptedRunReconciliation[]> {
    const runs = this.database
      .prepare(
        "SELECT run_id FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC, run_id ASC",
      )
      .all() as Array<{ run_id: string }>;
    return runs.map((run) =>
      this.reconcileInterruptedRun(run.run_id, occurredAt, fault),
    );
  }

  private reconcileInterruptedRun(
    runId: string,
    occurredAt: string,
    fault?: (phase: "attempt" | "run" | "journal", runId: string) => void,
  ): InterruptedRunReconciliation {
    return this.database.transaction(() => {
      const run = this.database
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(runId) as { status: RunStatus } | undefined;
      if (!run || !isNonTerminal(run.status))
        return { runId, reconciled: false, attemptsReconciled: 0 };

      fault?.("attempt", runId);
      const attempts = this.database
        .prepare(
          "UPDATE attempts SET status = 'failed', ended_at = ?, terminal_code = 'RUN_INTERRUPTED' WHERE run_id = ? AND status = 'running'",
        )
        .run(occurredAt, runId).changes;
      fault?.("run", runId);
      const runUpdate = this.database
        .prepare(
          "UPDATE runs SET status = 'failed', updated_at = ?, terminal_code = 'RUN_INTERRUPTED' WHERE run_id = ? AND status IN ('queued', 'running')",
        )
        .run(occurredAt, runId);
      if (runUpdate.changes !== 1)
        throw new Error(
          "Interrupted run reconciliation lost its terminal guard",
        );

      fault?.("journal", runId);
      const sequence = this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_journal_entries WHERE run_id = ?",
        )
        .get(runId) as { sequence: number };
      this.database
        .prepare(
          "INSERT INTO run_journal_entries (run_id, sequence, event_name, payload_json, occurred_at) VALUES (?, ?, 'run.reconciled', ?, ?)",
        )
        .run(
          runId,
          sequence.sequence + 1,
          JSON.stringify({
            reason: "process-restart",
            outcome: "failed",
            code: "RUN_INTERRUPTED",
          }),
          occurredAt,
        );
      return { runId, reconciled: true, attemptsReconciled: attempts };
    })();
  }
}

function isNonTerminal(status: RunStatus): status is "queued" | "running" {
  return status === "queued" || status === "running";
}
