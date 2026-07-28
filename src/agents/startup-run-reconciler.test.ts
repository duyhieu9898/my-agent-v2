import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteAttemptStore } from "./attempt-store.js";
import { AgentRuntime } from "./agent-runtime.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
import { SqliteRunStore } from "./run-store.js";
import { RuntimeEventBus } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import { StartupRunReconciler } from "./startup-run-reconciler.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { handleRunGet } from "../gateway/methods/runs.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import {
  createRuntimeAuthority,
  createTemporaryDatabase,
} from "../test/foundation-fixtures.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";

let database: AppDatabase;

beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
});
afterEach(() => database.close());

const at = "2026-07-27T00:00:00.000Z";
const reservationInput = (runId: string, attemptId: string) => ({
  modelCallId: `call-${runId}`,
  agentId: "primary",
  sessionId: "session-1",
  runId,
  attemptId,
  providerId: "gemini-developer" as const,
  modelId: "gemini-3.5-flash" as const,
  estimatedTokens: 5n,
  occurredAt: at,
});

async function persistRun(
  runs: SqliteRunStore,
  status: "queued" | "running",
  runId = `run-${status}`,
) {
  await runs.create({
    runId,
    agentId: "primary",
    sessionKey: "agent:primary:main",
    sessionId: "session-1",
    status,
    inputText: "interrupted input",
    createdAt: at,
    updatedAt: at,
  });
  return runId;
}

describe("StartupRunReconciler", () => {
  it("fails a queued run without inventing an attempt, journals once, and leaves a new admission slot", async () => {
    const runs = new SqliteRunStore(database);
    const runId = await persistRun(runs, "queued");
    const usage = new UsageBudgetGate(database, [], []);
    const reservation = await usage.reserve(reservationInput(runId, "unused"));
    const reconciler = new StartupRunReconciler(runs, usage);

    await expect(reconciler.reconcileInterruptedRuns(at)).resolves.toEqual({
      runs: [{ runId, reconciled: true, attemptsReconciled: 0 }],
    });
    expect(await runs.get(runId)).toMatchObject({
      status: "failed",
      terminalCode: "RUN_INTERRUPTED",
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?")
        .get(runId),
    ).toEqual({ count: 0 });
    await expect(
      new SqliteRunJournalStore(database).readPage(runId),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          eventName: "run.reconciled",
          payload: {
            reason: "process-restart",
            outcome: "failed",
            code: "RUN_INTERRUPTED",
          },
        }),
      ],
    });
    expect(
      database
        .prepare(
          "SELECT status FROM usage_reservations WHERE usage_reservation_id = ?",
        )
        .get(reservation.usageReservationId),
    ).toEqual({ status: "released" });
    await expect(persistRun(runs, "queued", "next-run")).resolves.toBe(
      "next-run",
    );
  });

  it("atomically fails a running attempt without replaying provider work", async () => {
    const runs = new SqliteRunStore(database);
    const attempts = new SqliteAttemptStore(database);
    const runId = await persistRun(runs, "running");
    await attempts.create("attempt-running", runId, at);
    const usage = new UsageBudgetGate(database, [], []);
    const reservation = await usage.reserve(
      reservationInput(runId, "attempt-running"),
    );
    await usage.markDispatched(reservation.usageReservationId, at);

    await new StartupRunReconciler(runs, usage).reconcileInterruptedRuns(at);

    expect(await runs.get(runId)).toMatchObject({
      status: "failed",
      terminalCode: "RUN_INTERRUPTED",
    });
    expect(await attempts.get("attempt-running")).toMatchObject({
      status: "failed",
      terminalCode: "RUN_INTERRUPTED",
    });
    expect(
      database
        .prepare(
          "SELECT status FROM usage_reservations WHERE usage_reservation_id = ?",
        )
        .get(reservation.usageReservationId),
    ).toEqual({ status: "uncertain" });
  });

  it("is idempotent across a second startup and never duplicates reconciliation evidence", async () => {
    const runs = new SqliteRunStore(database);
    const runId = await persistRun(runs, "running");
    const reconciler = new StartupRunReconciler(
      runs,
      new UsageBudgetGate(database, [], []),
    );
    await reconciler.reconcileInterruptedRuns(at);
    await expect(reconciler.reconcileInterruptedRuns(at)).resolves.toEqual({
      runs: [],
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ?",
        )
        .get(runId),
    ).toEqual({ count: 1 });
  });

  it("rolls back attempt, run, and journal when a reconciliation transaction fails", async () => {
    const runs = new SqliteRunStore(database);
    const attempts = new SqliteAttemptStore(database);
    const runId = await persistRun(runs, "running");
    await attempts.create("attempt-rollback", runId, at);

    await expect(
      runs.reconcileInterruptedRuns(at, (phase) => {
        if (phase === "run") throw new Error("run write unavailable");
      }),
    ).rejects.toThrow("run write unavailable");
    expect(await runs.get(runId)).toMatchObject({ status: "running" });
    expect(await attempts.get("attempt-rollback")).toMatchObject({
      status: "running",
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM run_journal_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps interrupted dispatched usage uncertain and cap-blocking after SQLite reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const runs = new SqliteRunStore(temporary.database);
    const runId = await persistRun(runs, "running");
    const policy = [
      { id: "cap", window: "day" as const, maxTokens: 5n, enabled: true },
    ];
    const gate = new UsageBudgetGate(temporary.database, policy, []);
    const reservation = await gate.reserve(
      reservationInput(runId, "attempt-usage"),
    );
    await gate.markDispatched(reservation.usageReservationId, at);
    await new StartupRunReconciler(runs, gate).reconcileInterruptedRuns(at);
    temporary.database.close();

    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    await expect(
      new UsageBudgetGate(reopened, policy, []).reserve(
        reservationInput("next-run", "next-attempt"),
      ),
    ).rejects.toMatchObject({ code: "USAGE_RESERVATION_FAILED" });
    reopened.close();
    temporary.close();
  });

  it("repairs the permanent terminal-commit failure on restart without replaying the provider", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    let providerCalls = 0;
    const events = new RuntimeEventBus();
    const infrastructureFailure = new Promise<void>((resolve) =>
      events.subscribe((event) => {
        if (event.eventName === "run.infrastructure_failed") resolve();
      }),
    );
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(temporary.database)),
      transcripts: new SqliteTranscriptStore(temporary.database),
      runs: new SqliteRunStore(temporary.database, () => {
        throw new Error("terminal storage unavailable");
      }),
      attempts: new SqliteAttemptStore(temporary.database),
      journal: new SqliteRunJournalStore(temporary.database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async () => {
          providerCalls += 1;
          return {
            text: "provider answer",
            billingCertainty: "actual-known" as const,
            usage: {
              providerTotalTokens: 2n,
              inputTokens: 1n,
              outputTokens: 1n,
              measurement: "provider-exact" as const,
            },
          };
        },
      },
      usageBudgetGate: new UsageBudgetGate(temporary.database, [], []),
    });
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "first",
    });
    await infrastructureFailure;
    expect(providerCalls).toBe(1);
    temporary.database.close();

    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const reopenedRuns = new SqliteRunStore(reopened);
    await new StartupRunReconciler(
      reopenedRuns,
      new UsageBudgetGate(reopened, [], []),
    ).reconcileInterruptedRuns(at);
    expect(providerCalls).toBe(1);
    expect(await reopenedRuns.get(admitted.runId)).toMatchObject({
      status: "failed",
      terminalCode: "RUN_INTERRUPTED",
    });
    expect(
      reopened
        .prepare("SELECT status, terminal_code FROM attempts WHERE run_id = ?")
        .get(admitted.runId),
    ).toEqual({ status: "failed", terminal_code: "RUN_INTERRUPTED" });
    expect(
      reopened
        .prepare("SELECT status FROM usage_reservations WHERE run_id = ?")
        .get(admitted.runId),
    ).toEqual({ status: "settled" });
    await expect(
      new SqliteRunJournalStore(reopened).readPage(admitted.runId),
    ).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ eventName: "run.reconciled" }),
      ]),
    });
    const session = await new SessionResolver(
      new SqliteSessionStore(reopened),
    ).resolve({
      kind: "main",
      agentId: "primary",
    });
    expect(
      (
        await new SqliteTranscriptStore(reopened).readPage(session.sessionId)
      ).entries.map((entry) => entry.type === "message" && entry.role),
    ).toEqual(["user", "assistant"]);

    const nextEvents = new RuntimeEventBus();
    const nextDone = new Promise<void>((resolve) =>
      nextEvents.subscribe((event) => {
        if (event.eventName === "run.completed") resolve();
      }),
    );
    const restartedRuntime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(reopened)),
      transcripts: new SqliteTranscriptStore(reopened),
      runs: reopenedRuns,
      journal: new SqliteRunJournalStore(reopened),
      events: nextEvents,
      lanes: new SessionRunLaneCoordinator(1),
    });
    await restartedRuntime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "next",
    });
    await nextDone;
    expect(providerCalls).toBe(1);

    const statusResponse = await handleRunGet({
      request: {
        type: "req",
        id: "status",
        method: "run.get",
        params: { runId: admitted.runId },
      },
      dependencies: { runs: reopenedRuns },
    } as never);
    expect(statusResponse).toMatchObject({
      ok: true,
      payload: { status: "failed", terminalCode: "RUN_INTERRUPTED" },
    });
    reopened.close();
    temporary.close();
  });
});
