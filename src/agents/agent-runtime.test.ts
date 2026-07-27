import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../sessions/in-memory-transcript-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { AgentRuntime } from "./agent-runtime.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
import { SqliteRunStore } from "./run-store.js";
import { RuntimeEventBus } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import { RuntimeCapacity } from "./runtime-capacity.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { ModelProviderError } from "../models/contracts.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";

let database: AppDatabase;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
});
afterEach(() => database.close());
describe("AgentRuntime", () => {
  it("admits after lane reservation and appends input once", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(2),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes,
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Cancelled",
    });
    expect(await runtime.cancel(accepted.runId)).toBe(true);
    releaseBlocker?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      ).entries.filter((entry) => entry.eventName.startsWith("finalize."))
        .length,
    ).toBe(1);
  });

  it("propagates cancellation to active deterministic execution", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    let started: (() => void) | undefined;
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      execute: (signal) =>
        new Promise<void>((resolve) => {
          started = () => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          };
        }),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Active",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    started?.();
    expect(await runtime.cancel(accepted.runId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
    expect(
      (
        await new SqliteRunJournalStore(database).readPage(accepted.runId)
      ).entries.filter((entry) => entry.eventName.startsWith("finalize."))
        .length,
    ).toBe(1);
  });

  it("does not publish provider success when its final transcript batch fails", async () => {
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
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
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
  });

  it("does not publish provider success when final journal persistence fails", async () => {
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
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new FinalJournalFailure(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider,
    });
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.requests).toHaveLength(1);
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runs = new SqliteRunStore(database);
    expect((await runs.get(failed.runId))?.status).toBe("failed");
    expect((await runs.get(completed.runId))?.status).toBe("completed");
  });

  it("routes every fake provider call through a durable usage reservation", async () => {
    const transcripts = new InMemoryTranscriptStore();
    const provider = new FakeModelProvider({
      text: "Answer",
      providerInteractionId: "opaque-id",
      billingCertainty: "actual-known",
      usage: { providerTotalTokens: 3n, measurement: "provider-exact" },
    });
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    ).toBe("opaque-id");
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
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(2),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      billingCertainty: "actual-known",
      usage: { providerTotalTokens: 2n, measurement: "provider-exact" },
    });
    const createRuntime = (current: AppDatabase) =>
      new AgentRuntime({
        sessions: new SessionResolver(new SqliteSessionStore(current)),
        transcripts: new SqliteTranscriptStore(current),
        runs: new SqliteRunStore(current),
        journal: new SqliteRunJournalStore(current),
        events: new RuntimeEventBus(),
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(current, [], []),
      });
    const first = createRuntime(temporary.database);
    await first.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const second = createRuntime(reopened);
    await second.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.requests[1]?.turns.map((turn) => turn.text)).toEqual([
      "First",
      "Answer",
      "Second",
    ]);
    reopened.close();
    temporary.close();
  });

  it("fails a model result that requires a missing continuation", async () => {
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("fails a malformed required continuation", async () => {
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("never dispatches a provider call when UsageBudgetGate is absent", async () => {
    let calls = 0;
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    expect(
      (await new SqliteRunStore(database).get(accepted.runId))?.status,
    ).toBe("failed");
  });

  it("does not replay a successful provider call when settlement persistence fails", async () => {
    let calls = 0;
    const gate = new UsageBudgetGate(database, [], []);
    gate.settle = async () => {
      throw new Error("settlement unavailable");
    };
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    const accepted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async () => {
          throw new ModelProviderError("rejected", "not-billable");
        },
      },
      usageBudgetGate: new UsageBudgetGate(database, [], []),
    });
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("released");
  });

  it("releases usage on a provider rate-limit rejection before billable execution", async () => {
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      provider: {
        execute: async () => {
          throw new ModelProviderError("rate limited", "not-billable");
        },
      },
    });
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("released");
  });

  it("propagates cancellation into provider I/O and retains uncertain usage", async () => {
    let started: (() => void) | undefined;
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      provider: {
        execute: async (_request, signal) =>
          new Promise((_, reject) => {
            started = () =>
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    started?.();
    await runtime.cancel(accepted.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    const runtime = new AgentRuntime({
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new FailingJournal(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Journal failure",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(false);
  });
});
