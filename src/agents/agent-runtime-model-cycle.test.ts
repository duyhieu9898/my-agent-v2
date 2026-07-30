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
import { RuntimeEventBus } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { ModelProviderError } from "../models/contracts.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { AgentRegistry, type AgentDefinition } from "./agent-registry.js";
import { BuiltinStepHarness } from "./harness.js";
import { HarnessRegistry } from "./harness-registry.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import {
  createRuntimeAuthority,
  primaryAgentDefinition,
} from "../test/foundation-fixtures.js";
import {
  assertTerminalTrace,
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
  it("fails an unknown harness before usage reservation, dispatch, and any provider call", async () => {
    const events = new RuntimeEventBus();
    const trace = createLifecycleTrace(events);
    const provider = new FakeModelProvider({
      text: "must not be used",
      billingCertainty: "actual-known",
      usage: { measurement: "unknown" },
    });
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
    expect(
      (await new SqliteRunStore(database).get(admitted.runId))?.terminalCode,
    ).toBe("HARNESS_NOT_FOUND");
    expect(provider.requests).toHaveLength(0);
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
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(runs.terminalTransitions).toBe(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ? AND event_name = 'finalize.failed'",
        )
        .get(admitted.runId),
    ).toEqual({ count: 1 });
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
});
