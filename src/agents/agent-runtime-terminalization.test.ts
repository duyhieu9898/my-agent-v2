import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../sessions/in-memory-transcript-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { AgentRuntime } from "./agent-runtime.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
import { SqliteRunStore } from "./run-store.js";
import { SqliteAttemptStore } from "./attempt-store.js";
import { RuntimeEventBus, type RuntimeEvent } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { ModelProviderError } from "../models/contracts.js";
import { createRuntimeAuthority } from "../test/foundation-fixtures.js";
import {
  assertTerminalTrace,
  collectTerminalEvents,
  createLifecycleTrace,
  terminalFor,
} from "./agent-runtime.test-support.js";

class CountingRunStore extends SqliteRunStore {
  public terminalTransitions = 0;
  override async commitTerminalOutcome(
    plan: Parameters<SqliteRunStore["commitTerminalOutcome"]>[0],
  ) {
    const result = await super.commitTerminalOutcome(plan);
    if (result === "committed") this.terminalTransitions += 1;
    return result;
  }
}

let database: AppDatabase;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
});
afterEach(() => database.close());

describe("AgentRuntime", () => {
  describe("terminal lifecycle matrix", () => {
    it.each([
      ["success", "complete", "completed", "run.completed", 1],
      ["queued cancellation", "cancel", "cancelled", "run.cancelled", 0],
      ["active cancellation", "cancel", "cancelled", "run.cancelled", 0],
      ["usage reservation blocked", "fail", "failed", "run.failed", 0],
      [
        "provider rejection before billable dispatch",
        "fail",
        "failed",
        "run.failed",
        1,
      ],
      [
        "provider timeout or disconnect after dispatch",
        "fail",
        "failed",
        "run.failed",
        1,
      ],
      ["malformed provider response", "fail", "failed", "run.failed", 1],
      ["continuation incompatibility", "fail", "failed", "run.failed", 0],
      ["transcript append failure", "fail", "failed", "run.failed", 0],
      ["required journal failure", "fail", "failed", "run.failed", 0],
      ["usage settlement failure", "fail", "failed", "run.failed", 1],
      [
        "cleanup or finalization failure",
        "complete",
        "completed",
        "run.completed",
        0,
      ],
    ] as const)(
      "%s reaches one terminal lifecycle",
      async (name, decision, durableStatus, terminalEvent, providerCalls) => {
        const events = new RuntimeEventBus();
        const trace = createLifecycleTrace(events);
        let calls = 0;
        let transcripts: TranscriptStore = new InMemoryTranscriptStore();
        let journal: SqliteRunJournalStore = new SqliteRunJournalStore(
          database,
        );
        let gate = new UsageBudgetGate(database, [], []);
        let provider: AgentRuntime extends never ? never : any;
        let lanes = new SessionRunLaneCoordinator(2);
        let execute: ((signal: AbortSignal) => Promise<void>) | undefined;
        let afterAdmit:
          ((runtime: AgentRuntime, runId: string) => Promise<void>) | undefined;

        if (name === "success") {
          provider = {
            execute: async () => {
              calls += 1;
              return {
                text: "answer",
                billingCertainty: "actual-known",
                usage: {
                  providerTotalTokens: 3n,
                  inputTokens: 1n,
                  outputTokens: 2n,
                  measurement: "provider-exact",
                },
              };
            },
          };
        } else if (name === "queued cancellation") {
          const reservation = lanes.reserve("primary:agent:primary:main");
          let release: (() => void) | undefined;
          reservation.enqueue(
            () => new Promise((resolve) => (release = resolve)),
          );
          afterAdmit = async (runtime, runId) => {
            await runtime.cancel(runId);
            release?.();
          };
        } else if (name === "active cancellation") {
          let entered: (() => void) | undefined;
          const enteredProvider = new Promise<void>(
            (resolve) => (entered = resolve),
          );
          execute = (signal) =>
            new Promise((resolve) => {
              entered?.();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          afterAdmit = async (runtime, runId) => {
            await enteredProvider;
            await runtime.cancel(runId);
          };
        } else if (name === "usage reservation blocked") {
          gate = new UsageBudgetGate(
            database,
            [{ id: "blocked", window: "day", maxTokens: 1n, enabled: true }],
            [],
          );
          provider = {
            execute: async () => {
              calls += 1;
              return {
                text: "no",
                billingCertainty: "actual-known",
                usage: { measurement: "unknown" },
              };
            },
          };
        } else if (name === "provider rejection before billable dispatch") {
          provider = {
            execute: async () => {
              calls += 1;
              throw new ModelProviderError("rejected", "not-billable");
            },
          };
        } else if (name === "provider timeout or disconnect after dispatch") {
          provider = {
            execute: async () => {
              calls += 1;
              throw new Error("disconnect after dispatch");
            },
          };
        } else if (name === "malformed provider response") {
          provider = {
            execute: async () => {
              calls += 1;
              return {
                text: "bad",
                requiresContinuation: true,
                billingCertainty: "actual-known",
                usage: { measurement: "unknown" },
              };
            },
          };
        } else if (name === "continuation incompatibility") {
          transcripts = {
            readPage: async () => ({
              entries: [
                {
                  type: "message",
                  role: "assistant",
                  sequence: 1,
                  continuationRequired: true,
                } as any,
              ],
            }),
            appendBatch: async () => [],
            readContinuation: async () => undefined,
          };
          provider = {
            execute: async () => {
              calls += 1;
              return {
                text: "no",
                billingCertainty: "actual-known",
                usage: { measurement: "unknown" },
              };
            },
          };
        } else if (name === "transcript append failure") {
          transcripts = {
            readPage: async () => ({ entries: [] }),
            appendBatch: async () => {
              throw new Error("append failed");
            },
            readContinuation: async () => undefined,
          };
        } else if (name === "required journal failure") {
          journal = new (class extends SqliteRunJournalStore {
            override async append(): Promise<never> {
              throw new Error("journal failed");
            }
          })(database);
        } else if (name === "usage settlement failure") {
          gate.settle = async () => {
            throw new Error("settle failed");
          };
          provider = {
            execute: async () => {
              calls += 1;
              return {
                text: "answer",
                billingCertainty: "actual-known",
                usage: {
                  providerTotalTokens: 3n,
                  inputTokens: 1n,
                  outputTokens: 2n,
                  measurement: "provider-exact",
                },
              };
            },
          };
        } else if (name === "cleanup or finalization failure") {
          journal = new (class extends SqliteRunJournalStore {
            override async append(
              input: Parameters<SqliteRunJournalStore["append"]>[0],
            ) {
              if (input.eventName.startsWith("finalize."))
                throw new Error("finalize journal failed");
              return super.append(input);
            }
          })(database);
        }

        const runs = new CountingRunStore(database);
        const attempts = new SqliteAttemptStore(database);
        const runtime = new AgentRuntime({
          ...createRuntimeAuthority(),
          sessions: new SessionResolver(new SqliteSessionStore(database)),
          transcripts,
          runs,
          attempts,
          journal,
          events,
          lanes,
          ...(execute ? { execute } : {}),
          ...(provider ? { provider, usageBudgetGate: gate } : {}),
          lifecycleProbe: trace.probe,
        });
        const admission = await runtime.admit({
          session: { kind: "main", agentId: "primary" },
          input: "Question",
        });
        await afterAdmit?.(runtime, admission.runId);
        expect((await trace.terminal(admission.runId)).eventName).toBe(
          terminalEvent,
        );
        expect(calls).toBe(providerCalls);
        await assertTerminalTrace(trace, events, runs, admission.runId, {
          decision,
          durableStatus,
          terminalEvent,
        });
        expect(runs.terminalTransitions).toBe(1);
        expect(
          database
            .prepare("SELECT status FROM attempts WHERE run_id = ?")
            .get(admission.runId),
        ).toEqual(
          name === "queued cancellation"
            ? undefined
            : { status: durableStatus },
        );
        if (name === "success") {
          expect(
            (
              database
                .prepare("SELECT status FROM usage_reservations")
                .get() as {
                status: string;
              }
            ).status,
          ).toBe("settled");
        }
      },
    );
  });

  it.each([
    ["attempt write", "attempt"],
    ["run write", "run"],
  ] as const)(
    "retries an atomic terminal commit when the %s fails once",
    async (_name, phase) => {
      let failures = 1;
      const events = new RuntimeEventBus();
      const trace = createLifecycleTrace(events);
      const runs = new CountingRunStore(database, (currentPhase) => {
        if (currentPhase === phase && failures > 0) {
          failures -= 1;
          throw new Error(`${phase} write failed once`);
        }
      });
      const runtime = new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions: new SessionResolver(new SqliteSessionStore(database)),
        transcripts: new InMemoryTranscriptStore(),
        runs,
        attempts: new SqliteAttemptStore(database),
        journal: new SqliteRunJournalStore(database),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        lifecycleProbe: trace.probe,
      });
      const admission = await runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "Question",
      });
      await trace.terminal(admission.runId);
      await assertTerminalTrace(trace, events, runs, admission.runId, {
        decision: "complete",
        durableStatus: "completed",
        terminalEvent: "run.completed",
      });
      expect(runs.terminalTransitions).toBe(1);
      expect(
        database
          .prepare("SELECT status FROM attempts WHERE run_id = ?")
          .get(admission.runId),
      ).toEqual({ status: "completed" });
    },
  );

  it("commits the checkpoint-authored fail-safe without publishing the primary event", async () => {
    const events = new RuntimeEventBus();
    const trace = createLifecycleTrace(events);
    const runs = new CountingRunStore(database, (_phase, plan) => {
      if (plan.runStatus === "completed")
        throw new Error("primary unavailable");
    });
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs,
      attempts: new SqliteAttemptStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      lifecycleProbe: trace.probe,
    });
    const admission = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await trace.terminal(admission.runId);
    await assertTerminalTrace(trace, events, runs, admission.runId, {
      decision: "complete",
      durableStatus: "failed",
      terminalEvent: "run.failed",
    });
    expect(runs.terminalTransitions).toBe(1);
    expect(
      database
        .prepare("SELECT status, terminal_code FROM attempts WHERE run_id = ?")
        .get(admission.runId),
    ).toEqual({ status: "failed", terminal_code: "TERMINAL_COMMIT_FAILED" });
    expect(
      events
        .snapshot()
        .filter(
          (event) =>
            event.runId === admission.runId &&
            event.eventName === "run.completed",
        ),
    ).toHaveLength(0);
  });

  it("surfaces permanent terminal storage failure without fabricating a terminal event", async () => {
    const events = new RuntimeEventBus();
    const infrastructureFailure = new Promise<RuntimeEvent>((resolve) =>
      events.subscribe((event) => {
        if (event.eventName === "run.infrastructure_failed") resolve(event);
      }),
    );
    const runs = new CountingRunStore(database, () => {
      throw new Error("storage unavailable");
    });
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs,
      attempts: new SqliteAttemptStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    const admission = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    expect((await infrastructureFailure).runId).toBe(admission.runId);
    expect(await runs.get(admission.runId)).toMatchObject({
      status: "running",
    });
    expect(
      database
        .prepare("SELECT status FROM attempts WHERE run_id = ?")
        .get(admission.runId),
    ).toEqual({ status: "running" });
    expect(
      events
        .snapshot()
        .filter(
          (event) =>
            event.runId === admission.runId &&
            (event.eventName === "run.infrastructure_failed" ||
              event.eventName === "run.completed" ||
              event.eventName === "run.failed" ||
              event.eventName === "run.cancelled" ||
              event.eventName === "finalize.completed" ||
              event.eventName === "finalize.failed" ||
              event.eventName === "finalize.cancelled"),
        ),
    ).toEqual([
      expect.objectContaining({ eventName: "run.infrastructure_failed" }),
    ]);
    expect(runs.terminalTransitions).toBe(0);
  });

  it("treats a duplicate terminal commit as an idempotent no-op", async () => {
    const events = new RuntimeEventBus();
    const runs = new CountingRunStore(database);
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs,
      attempts: new SqliteAttemptStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    const admission = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, admission.runId);
    const attempt = database
      .prepare("SELECT attempt_id FROM attempts WHERE run_id = ?")
      .get(admission.runId) as { attempt_id: string };
    await expect(
      runs.commitTerminalOutcome({
        runId: admission.runId,
        attemptId: attempt.attempt_id,
        runStatus: "completed",
        attemptStatus: "completed",
        occurredAt: new Date().toISOString(),
      }),
    ).resolves.toBe("already-committed-same-outcome");
    expect(runs.terminalTransitions).toBe(1);
    expect(
      events
        .snapshot()
        .filter(
          (event) =>
            event.runId === admission.runId &&
            event.eventName === "run.completed",
        ),
    ).toHaveLength(1);
  });

  it("does not publish completion when a required transcript commit fails", async () => {
    const events = new RuntimeEventBus();
    const transcripts: TranscriptStore = {
      readPage: async () => ({ entries: [] }),
      appendBatch: async () => {
        throw new Error("transcript unavailable");
      },
      readContinuation: async () => undefined,
    };
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Will fail",
    });
    await terminalFor(events, accepted.runId);
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
    expect(
      (
        await new SqliteRunJournalStore(database).readPage(accepted.runId)
      ).entries.filter(
        (entry) =>
          entry.eventName !== "finalize.started" &&
          entry.eventName.startsWith("finalize."),
      ).length,
    ).toBe(1);
  });

  it("does not publish provider success when its final transcript batch fails", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: {
        readPage: async () => ({ entries: [] }),
        appendBatch: async () => {
          throw new Error("transcript unavailable");
        },
        readContinuation: async () => undefined,
      },
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: new FakeModelProvider({
        text: "Answer",
        billingCertainty: "actual-known",
        usage: { measurement: "unknown" },
      }),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
  });

  it("keeps a completed decision when optional final journal cleanup fails", async () => {
    const events = new RuntimeEventBus();
    class FinalJournalFailure extends SqliteRunJournalStore {
      override async append(
        input: Parameters<SqliteRunJournalStore["append"]>[0],
      ) {
        if (input.eventName === "finalize.completed")
          throw new Error("journal unavailable");
        return super.append(input);
      }
    }
    const provider = new FakeModelProvider({
      text: "Answer",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new FinalJournalFailure(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider,
    });
    const terminalEvents = collectTerminalEvents(events);
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    expect((await terminalEvents.terminal(admitted.runId)).eventName).toBe(
      "run.completed",
    );
    terminalEvents.assertExactlyOne(admitted.runId);
    expect(provider.requests).toHaveLength(1);
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(true);
  });

  it("releases a lane after a cleanup-path failure", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    let failOnce = true;
    const transcripts: TranscriptStore = {
      readPage: async () => ({ entries: [] }),
      appendBatch: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transcript unavailable");
        }
        return [];
      },
      readContinuation: async () => undefined,
    };
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(2),
    });
    const failed = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    const completed = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await Promise.all([
      terminalFor(events, failed.runId),
      terminalFor(events, completed.runId),
    ]);
    const runs = new SqliteRunStore(database);
    expect((await runs.get(failed.runId))?.status).toBe("failed");
    expect((await runs.get(completed.runId))?.status).toBe("completed");
  });

  it("does not publish completion when a required journal write fails", async () => {
    const events = new RuntimeEventBus();
    class FailingJournal extends SqliteRunJournalStore {
      override async append(): Promise<never> {
        throw new Error("journal unavailable");
      }
    }
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new FailingJournal(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    const terminalEvents = collectTerminalEvents(events);
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Journal failure",
    });
    expect((await terminalEvents.terminal(admitted.runId)).eventName).toBe(
      "run.failed",
    );
    terminalEvents.assertExactlyOne(admitted.runId);
    expect(
      (await new SqliteRunStore(database).get(admitted.runId))?.status,
    ).toBe("failed");
  });
});
