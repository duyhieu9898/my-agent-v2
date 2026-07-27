import {
  SqliteRunStore,
  type InterruptedRunReconciliation,
} from "./run-store.js";
import type { UsageBudgetGate } from "../usage/usage-budget-gate.js";

export type StartupReconciliationResult = Readonly<{
  runs: readonly InterruptedRunReconciliation[];
}>;

/**
 * A startup-only, fail-closed cleanup. It never resumes, replays, or retries
 * interrupted work; it only terminalizes durable non-terminal rows.
 */
export class StartupRunReconciler {
  public constructor(
    private readonly runs: SqliteRunStore,
    private readonly usage: UsageBudgetGate,
  ) {}

  async reconcileInterruptedRuns(
    occurredAt: string,
  ): Promise<StartupReconciliationResult> {
    const runs = await this.runs.reconcileInterruptedRuns(occurredAt);
    await this.usage.recoverInterrupted(occurredAt);
    return { runs };
  }
}
