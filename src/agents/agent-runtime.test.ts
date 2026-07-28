import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../sessions/in-memory-transcript-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { AgentRuntime, type RuntimeLifecycleProbe } from "./agent-runtime.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
import { SqliteRunStore } from "./run-store.js";
import { SqliteAttemptStore } from "./attempt-store.js";
import { RuntimeEventBus, type RuntimeEvent } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import { RuntimeCapacity } from "./runtime-capacity.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { toGatewayRuntimeEvent } from "../gateway/runtime-event-translation.js";
import { ModelProviderError } from "../models/contracts.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { AgentRegistry, type AgentDefinition } from "./agent-registry.js";
import { BuiltinStepHarness } from "./harness.js";
import { HarnessRegistry } from "./harness-registry.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import {
  createRuntimeAuthority,
  createTemporaryDatabase,
  primaryAgentDefinition,
} from "../test/foundation-fixtures.js";

function collectTerminalEvents(events: RuntimeEventBus): {
  terminal(runId: string): Promise<RuntimeEvent>;
  assertExactlyOne(runId: string): void;
} {
  const buffered: RuntimeEvent[] = [];
  let targetRunId: string | undefined;
  let resolveTerminal: ((event: RuntimeEvent) => void) | undefined;
  const terminalReady = new Promise<RuntimeEvent>((resolve) => {
    resolveTerminal = resolve;
  });
  const isTerminal = (event: RuntimeEvent) =>
    event.eventName === "run.completed" ||
    event.eventName === "run.failed" ||
    event.eventName === "run.cancelled";
  const matching = (runId: string) =>
    buffered.filter((event) => event.runId === runId && isTerminal(event));
  events.subscribe((event) => {
    buffered.push(event);
    if (targetRunId && event.runId === targetRunId && isTerminal(event)) {
      resolveTerminal?.(event);
    }
  });

  return {
    async terminal(runId) {
      targetRunId = runId;
      const existing = matching(runId);
      if (existing.length > 0) {
        return existing[0]!;
      }
      return terminalReady;
    },
    assertExactlyOne(runId) {
      const terminalEvents = events
        .snapshot()
        .filter((event) => event.runId === runId && isTerminal(event));
      if (terminalEvents.length !== 1)
        throw new Error(`Expected exactly one terminal event for ${runId}`);
    },
  };
}

type TerminalDecision = "complete" | "cancel" | "fail";
type DurableStatus = "completed" | "cancelled" | "failed";
type TerminalEventName = "run.completed" | "run.cancelled" | "run.failed";

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

function terminalFor(
  events: RuntimeEventBus,
  runId: string,
): Promise<RuntimeEvent> {
  const isTerminal = (event: RuntimeEvent) =>
    event.eventName === "run.completed" ||
    event.eventName === "run.failed" ||
    event.eventName === "run.cancelled";
  const existing = events
    .snapshot()
    .find((event) => event.runId === runId && isTerminal(event));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    events.subscribe((event) => {
      if (event.runId === runId && isTerminal(event)) {
        resolve(event);
      }
    });
  });
}

function createLifecycleTrace(events: RuntimeEventBus): {
  probe: RuntimeLifecycleProbe;
  steps: Array<{ runId: string; step: string }>;
  terminal(runId: string): Promise<RuntimeEvent>;
} {
  const steps: Array<{ runId: string; step: string }> = [];
  return {
    probe: { record: (marker) => steps.push({ ...marker }) },
    steps,
    terminal: (runId) => terminalFor(events, runId),
  };
}

function assertTerminalTrace(
  trace: ReturnType<typeof createLifecycleTrace>,
  events: RuntimeEventBus,
  runs: SqliteRunStore,
  runId: string,
  expected: {
    decision: TerminalDecision;
    durableStatus: DurableStatus;
    terminalEvent: TerminalEventName;
  },
): Promise<void> {
  const steps = trace.steps
    .filter((entry) => entry.runId === runId)
    .map((entry) => entry.step);
  const count = (step: string) =>
    steps.filter((value) => value === step).length;
  const index = (step: string) => steps.indexOf(step);
  expect(count("run.admitted")).toBe(1);
  expect(count(`checkpoint.decision.${expected.decision}`)).toBe(1);
  expect(index(`checkpoint.decision.${expected.decision}`)).toBeLessThan(
    index("finalize.started"),
  );
  expect(count("finalize.started")).toBe(1);
  expect(count("finalize.completed")).toBe(1);
  expect(count(`run.state.${expected.durableStatus}.committed`)).toBe(1);
  expect(index(`run.state.${expected.durableStatus}.committed`)).toBeLessThan(
    index(`runtime-event.${expected.terminalEvent}.emitted`),
  );
  expect(count(`runtime-event.${expected.terminalEvent}.emitted`)).toBe(1);
  expect(
    events
      .snapshot()
      .filter(
        (event) =>
          event.runId === runId &&
          (event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled"),
      ),
  ).toHaveLength(1);
  return runs.get(runId).then((run) => {
    expect(run?.status).toBe(expected.durableStatus);
  });
}

function createSqliteRuntime(
  database: AppDatabase,
  events: RuntimeEventBus,
  provider: FakeModelProvider,
): AgentRuntime {
  return new AgentRuntime({
    ...createRuntimeAuthority(),
    sessions: new SessionResolver(new SqliteSessionStore(database)),
    transcripts: new SqliteTranscriptStore(database),
    runs: new SqliteRunStore(database),
    journal: new SqliteRunJournalStore(database),
    events,
    lanes: new SessionRunLaneCoordinator(1),
    provider,
    usageBudgetGate: new UsageBudgetGate(database, [], []),
  });
}

function opaqueContinuation(modelCallId: string, payload: string) {
  return {
    version: "gemini-thought-signature-v1",
    payload: new TextEncoder().encode(payload),
    providerId: "gemini-developer" as const,
    modelId: "gemini-3.5-flash" as const,
    modelCallId,
  };
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

  it("admits after lane reservation and appends input once", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
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
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Hello",
    });
    await terminalFor(events, accepted.runId);
    const run = await new SqliteRunStore(database).get(accepted.runId);
    expect(run?.status).toBe("completed");
    const session = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    expect(
      (await transcripts.readPage(session.sessionId)).entries,
    ).toHaveLength(1);
  });

  it("rejects a full lane before exposing a run or appending input", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    const first = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await expect(
      runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "Second",
      }),
    ).rejects.toMatchObject({ code: "SESSION_RUN_QUEUE_FULL" });
    await terminalFor(events, first.runId);
    const session = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    expect(
      (await transcripts.readPage(session.sessionId)).entries,
    ).toHaveLength(1);
    expect((await new SqliteRunStore(database).get(first.runId))?.status).toBe(
      "completed",
    );
  });

  it("accepts different sessions while applying a separate shared capacity seam", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(2),
      capacity: new RuntimeCapacity(1),
    });
    const [first, second] = await Promise.all([
      runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "One",
      }),
      runtime.admit({
        session: {
          kind: "channel",
          agentId: "primary",
          channel: "test",
          conversationId: "two",
        },
        input: "Two",
      }),
    ]);
    await Promise.all([
      terminalFor(events, first.runId),
      terminalFor(events, second.runId),
    ]);
    const runs = new SqliteRunStore(database);
    expect((await runs.get(first.runId))?.status).toBe("completed");
    expect((await runs.get(second.runId))?.status).toBe("completed");
  });

  it("starts different sessions concurrently when shared capacity permits", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    let started = 0;
    let resolveBothStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      capacity: new RuntimeCapacity(2),
      execute: async () => {
        started += 1;
        if (started === 2) resolveBothStarted?.();
        await finished;
      },
    });
    const twoStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    await Promise.all([
      runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "One",
      }),
      runtime.admit({
        session: {
          kind: "channel",
          agentId: "primary",
          channel: "test",
          conversationId: "two",
        },
        input: "Two",
      }),
    ]);
    await twoStarted;
    release?.();
  });

  it("rejects explicitly unknown agents without fallback", async () => {
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
    });
    await expect(
      runtime.admit({
        session: { kind: "main", agentId: "unknown" },
        agentId: "unknown",
        input: "No",
      }),
    ).rejects.toThrow("AGENT_NOT_FOUND");
  });

  it("cancels queued work without appending its input", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    const lanes = new SessionRunLaneCoordinator(2);
    let releaseBlocker: (() => void) | undefined;
    const blocker = lanes.reserve("primary:agent:primary:main");
    blocker.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    );
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes,
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Cancelled",
    });
    expect(await runtime.cancel(accepted.runId)).toBe(true);
    releaseBlocker?.();
    await terminalFor(events, accepted.runId);
    const session = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    expect(
      (await transcripts.readPage(session.sessionId)).entries,
    ).toHaveLength(0);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("cancelled");
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

  it("propagates cancellation to active deterministic execution", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    let entered: (() => void) | undefined;
    const enteredExecution = new Promise<void>(
      (resolve) => (entered = resolve),
    );
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      execute: (signal) =>
        new Promise<void>((resolve) => {
          entered?.();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Active",
    });
    await enteredExecution;
    expect(await runtime.cancel(accepted.runId)).toBe(true);
    await terminalFor(events, accepted.runId);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("cancelled");
    const entries = await new SqliteRunJournalStore(database).readPage(
      accepted.runId,
    );
    expect(
      entries.entries.filter(
        (entry) => entry.eventName === "finalize.cancelled",
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

  it("fails an unknown harness before usage reservation, dispatch, and any provider call", async () => {
    const events = new RuntimeEventBus();
    const trace = createLifecycleTrace(events);
    const provider = new FakeModelProvider({
      text: "must not be used",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    // The resolved snapshot references a harness id that no registry holds.
    const unknownHarnessDefinition: AgentDefinition = {
      ...primaryAgentDefinition,
      harnessId: "missing-harness",
    };
    const runs = new CountingRunStore(database);
    const runtime = new AgentRuntime({
      agentRegistry: new AgentRegistry([unknownHarnessDefinition]),
      harnessRegistry: new HarnessRegistry([
        { id: "builtin-step", harness: new BuiltinStepHarness() },
      ]),
      tokenEstimator: new HeuristicTokenEstimator(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new SqliteTranscriptStore(database),
      runs,
      attempts: new SqliteAttemptStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      lifecycleProbe: trace.probe,
    });
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    expect((await trace.terminal(admitted.runId)).eventName).toBe("run.failed");
    await assertTerminalTrace(trace, events, runs, admitted.runId, {
      decision: "fail",
      durableStatus: "failed",
      terminalEvent: "run.failed",
    });
    // Typed harness error is preserved through the terminal decision.
    expect(
      (await new SqliteRunStore(database).get(admitted.runId))?.terminalCode,
    ).toBe("HARNESS_NOT_FOUND");
    // Zero provider invocation.
    expect(provider.requests).toHaveLength(0);
    // No model-call usage side effects: no reservation, no usage.reserved
    // journal event, no usage record, and no dispatch marker.
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_reservations WHERE run_id = ?",
        )
        .get(admitted.runId),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ? AND event_name = 'usage.reserved'",
        )
        .get(admitted.runId),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM usage_records").get(),
    ).toEqual({ count: 0 });
    // No false assistant transcript was appended for the failed run.
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant'",
        )
        .get(),
    ).toEqual({ count: 0 });
    // Finalization happened exactly once.
    expect(runs.terminalTransitions).toBe(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ? AND event_name = 'finalize.failed'",
        )
        .get(admitted.runId),
    ).toEqual({ count: 1 });
    // Lane released: a later admit on the same session is accepted once the
    // failed run's drain completes. setImmediate yields deterministically until
    // the lane's finally releases the active slot.
    let secondRunId: string | undefined;
    for (let i = 0; i < 200 && !secondRunId; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const admitted2 = await runtime.admit({
          session: { kind: "main", agentId: "primary" },
          input: "b",
        });
        secondRunId = admitted2.runId;
      } catch {
        /* lane still draining the failed run */
      }
    }
    expect(secondRunId).toBeDefined();
    expect(secondRunId).not.toBe(admitted.runId);
  });

  it("routes every fake provider call through a durable usage reservation", async () => {
    const transcripts = new InMemoryTranscriptStore();
    const provider = new FakeModelProvider({
      text: "Answer",
      continuation: {
        version: "gemini-thought-signature-v1",
        payload: new TextEncoder().encode("opaque-signature"),
      },
      billingCertainty: "actual-known",
      usage: {
        providerTotalTokens: 3n,
        inputTokens: 1n,
        outputTokens: 2n,
        measurement: "provider-exact",
      },
    });
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(provider.requests).toHaveLength(1);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("settled");
    const session = await new SessionResolver(
      new SqliteSessionStore(database),
    ).resolve({ kind: "main", agentId: "primary" });
    expect(
      (await transcripts.readPage(session.sessionId)).entries.map((entry) =>
        entry.type === "message" ? entry.text : "",
      ),
    ).toEqual(["Question", "Answer"]);
    expect(
      new TextDecoder().decode(
        (await transcripts.readContinuation(session.sessionId, 2))?.payload,
      ),
    ).toBe("opaque-signature");
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("completed");
    expect(
      (await new SqliteRunJournalStore(database).readPage(accepted.runId))
        .entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "run.accepted",
          payload: expect.objectContaining({ agentRevision: "primary-v1" }),
        }),
      ]),
    );
    expect(
      (
        await new SqliteRunJournalStore(database).readPage(accepted.runId)
      ).entries.filter((entry) => entry.eventName === "finalize.completed")
        .length,
    ).toBe(1);
  });

  it("reconstructs a second model turn from local transcript without provider continuation", async () => {
    const transcripts = new InMemoryTranscriptStore();
    const provider = new FakeModelProvider({
      text: "Answer",
      billingCertainty: "actual-known",
      usage: { providerTotalTokens: 2n, measurement: "provider-exact" },
    });
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(2),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const first = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await terminalFor(events, first.runId);
    const second = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await terminalFor(events, second.runId);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.turns.map((turn) => turn.text)).toEqual([
      "First",
      "Answer",
      "Second",
    ]);
  });

  it("reconstructs the next turn from SQLite transcript after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const provider = new FakeModelProvider({
      text: "Answer",
      continuation: {
        version: "gemini-thought-signature-v1",
        payload: new TextEncoder().encode("reopen-signature"),
      },
      billingCertainty: "actual-known",
      usage: { providerTotalTokens: 2n, measurement: "provider-exact" },
    });
    const createRuntime = (current: AppDatabase, events: RuntimeEventBus) =>
      new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions: new SessionResolver(new SqliteSessionStore(current)),
        transcripts: new SqliteTranscriptStore(current),
        runs: new SqliteRunStore(current),
        journal: new SqliteRunJournalStore(current),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(current, [], []),
      });
    const firstEvents = new RuntimeEventBus();
    const firstTerminal = new Promise<string>((resolve) =>
      firstEvents.subscribe((event) => {
        if (
          event.runId &&
          (event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled")
        )
          resolve(event.eventName);
      }),
    );
    const first = createRuntime(temporary.database, firstEvents);
    const firstAdmission = await first.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    const firstEvent = await firstTerminal;
    expect({
      event: firstEvent,
      terminalCode: (
        await new SqliteRunStore(temporary.database).get(firstAdmission.runId)
      )?.terminalCode,
    }).toEqual({ event: "run.completed", terminalCode: undefined });
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const secondEvents = new RuntimeEventBus();
    const secondDone = new Promise<void>((resolve) =>
      secondEvents.subscribe((event) => {
        if (event.eventName === "run.completed") resolve();
      }),
    );
    const second = createRuntime(reopened, secondEvents);
    await second.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await secondDone;
    expect(provider.requests[1]?.turns.map((turn) => turn.text)).toEqual([
      "First",
      "Answer",
      "Second",
    ]);
    expect(provider.requests[1]?.continuations?.[0]?.version).toBe(
      "gemini-thought-signature-v1",
    );
    expect(
      new TextDecoder().decode(
        provider.requests[1]?.continuations?.[0]?.payload,
      ),
    ).toBe("reopen-signature");
    reopened.close();
    temporary.close();
  });

  it("fails when a required persisted continuation is missing after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const provider = new FakeModelProvider({
      text: "Answer",
      continuation: {
        version: "gemini-thought-signature-v1",
        payload: new TextEncoder().encode(
          "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
        ),
      },
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const makeRuntime = (current: AppDatabase, events: RuntimeEventBus) =>
      new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions: new SessionResolver(new SqliteSessionStore(current)),
        transcripts: new SqliteTranscriptStore(current),
        runs: new SqliteRunStore(current),
        journal: new SqliteRunJournalStore(current),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(current, [], []),
      });
    const firstEvents = new RuntimeEventBus();
    const firstDone = new Promise<void>((resolve) =>
      firstEvents.subscribe(
        (event) => event.eventName === "run.completed" && resolve(),
      ),
    );
    await makeRuntime(temporary.database, firstEvents).admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await firstDone;
    temporary.database.prepare("DELETE FROM transcript_continuations").run();
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const terminal = new Promise<string>((resolve) =>
      events.subscribe(
        (event) =>
          event.runId &&
          (event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled") &&
          resolve(event.eventName),
      ),
    );
    await makeRuntime(reopened, events).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect(await terminal).toBe("run.failed");
    expect(provider.requests).toHaveLength(1);
    reopened.close();
    temporary.close();
  });

  it.each([
    ["payload is empty", new Uint8Array(), "gemini-thought-signature-v1"],
    [
      "payload is whitespace-only",
      new TextEncoder().encode("   "),
      "gemini-thought-signature-v1",
    ],
    [
      "persisted continuation payload is malformed",
      new Uint8Array([0xff]),
      "gemini-thought-signature-v1",
    ],
    [
      "continuation schema is unsupported",
      new TextEncoder().encode("SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE"),
      "unsupported-schema-v1",
    ],
    [
      "continuation version is unsupported",
      new TextEncoder().encode("SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE"),
      "gemini-thought-signature-v2",
    ],
  ])("fails after reopen when %s", async (_case, payload, version) => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const provider = new FakeModelProvider({
      text: "Answer",
      continuation: {
        version: "gemini-thought-signature-v1",
        payload: new TextEncoder().encode("good"),
      },
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const build = (current: AppDatabase, events: RuntimeEventBus) =>
      new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions: new SessionResolver(new SqliteSessionStore(current)),
        transcripts: new SqliteTranscriptStore(current),
        runs: new SqliteRunStore(current),
        journal: new SqliteRunJournalStore(current),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(current, [], []),
      });
    const initialEvents = new RuntimeEventBus();
    const initialDone = new Promise<void>((resolve) =>
      initialEvents.subscribe(
        (event) => event.eventName === "run.completed" && resolve(),
      ),
    );
    await build(temporary.database, initialEvents).admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await initialDone;
    temporary.database
      .prepare(
        "UPDATE transcript_continuations SET continuation_version = ?, continuation_payload = ?",
      )
      .run(version, payload);
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const observed: unknown[] = [];
    const terminal = new Promise<string>((resolve) =>
      events.subscribe((event) => {
        observed.push(event);
        if (
          event.runId &&
          (event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled")
        )
          resolve(event.eventName);
      }),
    );
    const run = await build(reopened, events).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect(await terminal).toBe("run.failed");
    expect(
      (await new SqliteRunStore(reopened).get(run.runId))?.terminalCode,
    ).toBe("MODEL_HISTORY_INCOMPATIBLE");
    expect(provider.requests).toHaveLength(1);
    const journal = await new SqliteRunJournalStore(reopened).readPage(
      run.runId,
    );
    const publicText = JSON.stringify([
      observed,
      journal.entries,
      (
        await new SqliteTranscriptStore(reopened).readPage(
          (
            await new SessionResolver(new SqliteSessionStore(reopened)).resolve(
              { kind: "main", agentId: "primary" },
            )
          ).sessionId,
        )
      ).entries,
    ]);
    expect(publicText).not.toContain(
      "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
    );
    reopened.close();
    temporary.close();
  });

  it.each([
    ["continuation provider does not match", "provider_id", "other-provider"],
    ["continuation model does not match", "model_id", "gemini-other-model"],
    ["continuation provider metadata is missing", "provider_id", null],
    ["continuation model metadata is missing", "model_id", null],
    ["continuation model call metadata is missing", "model_call_id", null],
    [
      "continuation belongs to another model call",
      "model_call_id",
      "model-call-B",
    ],
  ])("fails after reopen when %s", async (_case, column, value) => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const provider = new FakeModelProvider({
      text: "Answer",
      continuation: {
        version: "gemini-thought-signature-v1",
        payload: new TextEncoder().encode(
          "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
        ),
      },
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const build = (current: AppDatabase, events: RuntimeEventBus) =>
      new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions: new SessionResolver(new SqliteSessionStore(current)),
        transcripts: new SqliteTranscriptStore(current),
        runs: new SqliteRunStore(current),
        journal: new SqliteRunJournalStore(current),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(current, [], []),
      });
    const sessions = new SessionResolver(
      new SqliteSessionStore(temporary.database),
    );
    const session = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    await new SqliteTranscriptStore(temporary.database).appendBatch({
      sessionId: session.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "user-a",
          role: "user",
          text: "First",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "assistant-a",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-01-01T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
          continuation: {
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode(
              "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
            ),
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-A",
          },
        },
      ],
    });
    temporary.database
      .prepare(`UPDATE transcript_continuations SET ${column} = ?`)
      .run(value);
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const run = await build(reopened, events).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect((await terminalEvents.terminal(run.runId)).eventName).toBe(
      "run.failed",
    );
    terminalEvents.assertExactlyOne(run.runId);
    expect(
      (await new SqliteRunStore(reopened).get(run.runId))?.terminalCode,
    ).toBe("MODEL_HISTORY_INCOMPATIBLE");
    expect(provider.requests).toHaveLength(0);
    const journal = await new SqliteRunJournalStore(reopened).readPage(
      run.runId,
    );
    expect(JSON.stringify([journal.entries, events.snapshot()])).not.toContain(
      "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
    );
    reopened.close();
    temporary.close();
  });

  it("reconstructs continuation when assistant and sidecar model call ids match after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const session = await new SessionResolver(
      new SqliteSessionStore(temporary.database),
    ).resolve({ kind: "main", agentId: "primary" });
    await new SqliteTranscriptStore(temporary.database).appendBatch({
      sessionId: session.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "u",
          role: "user",
          text: "First",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "a",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-01-01T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
          continuation: {
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("valid"),
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-A",
          },
        },
      ],
    });
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const provider = new FakeModelProvider({
      text: "Next",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(reopened)),
      transcripts: new SqliteTranscriptStore(reopened),
      runs: new SqliteRunStore(reopened),
      journal: new SqliteRunJournalStore(reopened),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(reopened, [], []),
    });
    const admission = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect((await terminalEvents.terminal(admission.runId)).eventName).toBe(
      "run.completed",
    );
    terminalEvents.assertExactlyOne(admission.runId);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.continuations?.[0]?.modelCallId).toBe(
      "model-call-A",
    );
    reopened.close();
    temporary.close();
  });

  it("fails after reopen when continuation-required assistant entry has no model call id", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const session = await new SessionResolver(
      new SqliteSessionStore(temporary.database),
    ).resolve({ kind: "main", agentId: "primary" });
    await new SqliteTranscriptStore(temporary.database).appendBatch({
      sessionId: session.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "u",
          role: "user",
          text: "First",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "a",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-01-01T00:00:01.000Z",
          continuationRequired: true,
          continuation: {
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("valid"),
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-A",
          },
        },
      ],
    });
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const provider = new FakeModelProvider({
      text: "Next",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(reopened)),
      transcripts: new SqliteTranscriptStore(reopened),
      runs: new SqliteRunStore(reopened),
      journal: new SqliteRunJournalStore(reopened),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(reopened, [], []),
    });
    const admission = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect((await terminalEvents.terminal(admission.runId)).eventName).toBe(
      "run.failed",
    );
    terminalEvents.assertExactlyOne(admission.runId);
    expect(provider.requests).toHaveLength(0);
    expect(
      (await new SqliteRunStore(reopened).get(admission.runId))?.terminalCode,
    ).toBe("MODEL_HISTORY_INCOMPATIBLE");
    reopened.close();
    temporary.close();
  });

  it("does not use a continuation belonging to another session after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const sessions = new SessionResolver(
      new SqliteSessionStore(temporary.database),
    );
    const sessionA = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    const sessionB = await sessions.resolve({
      kind: "channel",
      agentId: "primary",
      channel: "web",
      conversationId: "other",
    });
    const store = new SqliteTranscriptStore(temporary.database);
    await store.appendBatch({
      sessionId: sessionA.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "a-user",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "a-assistant",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
        },
      ],
    });
    await store.appendBatch({
      sessionId: sessionB.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "b-user",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "b-assistant",
          role: "assistant",
          text: "Answer",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-A",
          continuation: opaqueContinuation(
            "model-call-A",
            "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
          ),
        },
      ],
    });
    temporary.database.close();

    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const provider = new FakeModelProvider({
      text: "Next",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const admission = await createSqliteRuntime(
      reopened,
      events,
      provider,
    ).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    expect((await terminalEvents.terminal(admission.runId)).eventName).toBe(
      "run.failed",
    );
    terminalEvents.assertExactlyOne(admission.runId);
    const run = await new SqliteRunStore(reopened).get(admission.runId);
    const journal = await new SqliteRunJournalStore(reopened).readPage(
      admission.runId,
    );
    const publicSurfaces = JSON.stringify([
      run,
      journal.entries,
      events.snapshot(),
      events
        .snapshot()
        .map((event, index) => toGatewayRuntimeEvent(event, index)),
      (await new SqliteTranscriptStore(reopened).readPage(sessionA.sessionId))
        .entries,
    ]);
    expect(run?.terminalCode).toBe("MODEL_HISTORY_INCOMPATIBLE");
    expect(
      journal.entries.filter(
        (entry) => entry.eventName === "checkpoint.decision",
      ),
    ).toHaveLength(1);
    expect(
      journal.entries.filter((entry) => entry.eventName === "finalize.failed"),
    ).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(publicSurfaces).not.toContain(
      "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
    );
    reopened.close();
    temporary.close();
  });

  it("does not use a continuation belonging to another exchange after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const session = await new SessionResolver(
      new SqliteSessionStore(temporary.database),
    ).resolve({ kind: "main", agentId: "primary" });
    await new SqliteTranscriptStore(temporary.database).appendBatch({
      sessionId: session.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "user-1",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "assistant-1",
          role: "assistant",
          text: "One",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-1",
          continuation: opaqueContinuation(
            "model-call-1",
            "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
          ),
        },
        {
          type: "message",
          id: "user-2",
          role: "user",
          text: "Second",
          createdAt: "2026-07-27T00:00:02.000Z",
        },
        {
          type: "message",
          id: "assistant-2",
          role: "assistant",
          text: "Two",
          createdAt: "2026-07-27T00:00:03.000Z",
          continuationRequired: true,
          modelCallId: "model-call-2",
        },
      ],
    });
    temporary.database.close();

    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const provider = new FakeModelProvider({
      text: "Next",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const admission = await createSqliteRuntime(
      reopened,
      events,
      provider,
    ).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Third",
    });
    expect((await terminalEvents.terminal(admission.runId)).eventName).toBe(
      "run.failed",
    );
    terminalEvents.assertExactlyOne(admission.runId);
    expect(
      (await new SqliteRunStore(reopened).get(admission.runId))?.terminalCode,
    ).toBe("MODEL_HISTORY_INCOMPATIBLE");
    expect(provider.requests).toHaveLength(0);
    reopened.close();
    temporary.close();
  });

  it("reconstructs multiple continuations in exact transcript exchange order after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const session = await new SessionResolver(
      new SqliteSessionStore(temporary.database),
    ).resolve({ kind: "main", agentId: "primary" });
    await new SqliteTranscriptStore(temporary.database).appendBatch({
      sessionId: session.sessionId,
      expectedTailSequence: 0,
      entries: [
        {
          type: "message",
          id: "user-1",
          role: "user",
          text: "First",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          type: "message",
          id: "assistant-1",
          role: "assistant",
          text: "One",
          createdAt: "2026-07-27T00:00:01.000Z",
          continuationRequired: true,
          modelCallId: "model-call-1",
        },
        {
          type: "message",
          id: "user-2",
          role: "user",
          text: "Second",
          createdAt: "2026-07-27T00:00:02.000Z",
        },
        {
          type: "message",
          id: "assistant-2",
          role: "assistant",
          text: "Two",
          createdAt: "2026-07-27T00:00:03.000Z",
          continuationRequired: true,
          modelCallId: "model-call-2",
        },
      ],
    });
    const insertContinuation = temporary.database.prepare(`
      INSERT INTO transcript_continuations (
        session_id, sequence, continuation_version, continuation_payload,
        provider_id, model_id, model_call_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertContinuation.run(
      session.sessionId,
      4,
      "gemini-thought-signature-v1",
      new TextEncoder().encode("second-signature"),
      "gemini-developer",
      "gemini-3.5-flash",
      "model-call-2",
    );
    insertContinuation.run(
      session.sessionId,
      2,
      "gemini-thought-signature-v1",
      new TextEncoder().encode("first-signature"),
      "gemini-developer",
      "gemini-3.5-flash",
      "model-call-1",
    );
    temporary.database.close();

    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const events = new RuntimeEventBus();
    const terminalEvents = collectTerminalEvents(events);
    const provider = new FakeModelProvider({
      text: "Third answer",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
    const admission = await createSqliteRuntime(
      reopened,
      events,
      provider,
    ).admit({
      session: { kind: "main", agentId: "primary" },
      input: "Third",
    });
    expect((await terminalEvents.terminal(admission.runId)).eventName).toBe(
      "run.completed",
    );
    terminalEvents.assertExactlyOne(admission.runId);
    expect(provider.requests).toHaveLength(1);
    expect(
      provider.requests[0]?.continuations?.map((continuation) => ({
        modelCallId: continuation.modelCallId,
        payload: new TextDecoder().decode(continuation.payload),
      })),
    ).toEqual([
      { modelCallId: "model-call-1", payload: "first-signature" },
      { modelCallId: "model-call-2", payload: "second-signature" },
    ]);
    reopened.close();
    temporary.close();
  });

  it("fails a model result that requires a missing continuation", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: new FakeModelProvider({
        text: "Answer",
        requiresContinuation: true,
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
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("fails a malformed required continuation", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: new FakeModelProvider({
        text: "Answer",
        requiresContinuation: true,
        continuation: { version: "", payload: new Uint8Array() },
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
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("never dispatches a provider call when UsageBudgetGate is absent", async () => {
    let calls = 0;
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async () => {
          calls += 1;
          return {
            text: "no",
            billingCertainty: "actual-known" as const,
            usage: { measurement: "unknown" as const },
          };
        },
      },
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(calls).toBe(0);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("does not replay a successful provider call when settlement persistence fails", async () => {
    let calls = 0;
    const events = new RuntimeEventBus();
    const gate = new UsageBudgetGate(database, [], []);
    gate.settle = async () => {
      throw new Error("settlement unavailable");
    };
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: gate,
      provider: {
        execute: async () => {
          calls += 1;
          return {
            text: "Answer",
            billingCertainty: "actual-known" as const,
            usage: {
              providerTotalTokens: 1n,
              inputTokens: 1n,
              outputTokens: 0n,
              measurement: "provider-exact" as const,
            },
          };
        },
      },
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(calls).toBe(1);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("uncertain");
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("retains an uncertain reservation when provider dispatch fails", async () => {
    const provider = {
      execute: async () => {
        throw new Error("network timeout after dispatch");
      },
    };
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("uncertain");
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("releases usage when the provider proves rejection was not billable", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async () => {
          throw new ModelProviderError("rejected", "not-billable");
        },
      },
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("released");
  });

  it("releases usage on a provider rate-limit rejection before billable execution", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: {
        execute: async () => {
          throw new ModelProviderError("rate limited", "not-billable");
        },
      },
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("released");
  });

  it("propagates cancellation into provider I/O and retains uncertain usage", async () => {
    let entered: (() => void) | undefined;
    const providerEntered = new Promise<void>((resolve) => (entered = resolve));
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async (_request, signal) =>
          new Promise((_, reject) => {
            entered?.();
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  new ModelProviderError("cancelled", "billing-ambiguous"),
                ),
              { once: true },
            );
          }),
      },
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await providerEntered;
    await runtime.cancel(accepted.runId);
    await terminalFor(events, accepted.runId);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("uncertain");
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("cancelled");
  });

  it("times out provider I/O, aborts transport, and retains uncertain usage", async () => {
    let sawAbort = false;
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      runTimeoutMs: 5,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: {
        execute: async (_request, signal) =>
          new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                reject(new Error("aborted"));
              },
              { once: true },
            ),
          ),
      },
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await terminalFor(events, accepted.runId);
    expect(sawAbort).toBe(true);
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("uncertain");
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("fails a timed out run and releases its lane for the next accepted run", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    let first = true;
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(2),
      runTimeoutMs: 5,
      execute: async () => {
        if (first) {
          first = false;
          await new Promise<void>(() => undefined);
        }
      },
    });
    const timedOut = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Timeout",
    });
    const next = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Next",
    });
    await Promise.all([
      terminalFor(events, timedOut.runId),
      terminalFor(events, next.runId),
    ]);
    const runs = new SqliteRunStore(database);
    expect((await runs.get(timedOut.runId))?.status).toBe("failed");
    expect((await runs.get(next.runId))?.status).toBe("completed");
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
