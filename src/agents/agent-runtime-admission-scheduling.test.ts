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
import { createRuntimeAuthority } from "../test/foundation-fixtures.js";
import { terminalFor } from "./agent-runtime.test-support.js";

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
});
