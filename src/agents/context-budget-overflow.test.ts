import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BuiltinStepHarness } from "./harness.js";
import { HarnessRegistry } from "./harness-registry.js";
import { AgentRuntime } from "./agent-runtime.js";
import { AgentRegistry, type AgentDefinition } from "./agent-registry.js";
import { SqliteRunJournalStore } from "./run-journal-store.js";
import { SqliteRunStore } from "./run-store.js";
import { RuntimeEventBus } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { primaryAgentDefinition } from "../test/foundation-fixtures.js";

const INSTRUCTIONS = "You are the primary my-agent-v2 assistant.";

function estimateFor(input: string): bigint {
  return new HeuristicTokenEstimator().estimate({
    instructions: [INSTRUCTIONS],
    turns: [{ role: "user", text: input }],
  });
}

function buildRuntime(
  database: AppDatabase,
  events: RuntimeEventBus,
  definition: AgentDefinition,
  provider: FakeModelProvider,
): AgentRuntime {
  return new AgentRuntime({
    agentRegistry: new AgentRegistry([definition]),
    harnessRegistry: new HarnessRegistry([
      { id: "builtin-step", harness: new BuiltinStepHarness() },
    ]),
    tokenEstimator: new HeuristicTokenEstimator(),
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

function terminalOf(events: RuntimeEventBus, runId: string): Promise<string> {
  return new Promise((resolve) => {
    const unsubscribe = events.subscribe((event) => {
      if (
        event.runId === runId &&
        (event.eventName === "run.completed" ||
          event.eventName === "run.failed" ||
          event.eventName === "run.cancelled")
      ) {
        unsubscribe();
        resolve(event.eventName);
      }
    });
  });
}

describe("AgentRuntime context token budget", () => {
  let database: AppDatabase;
  beforeEach(() => {
    database = openDatabase(":memory:");
    migrateDatabase(database);
  });
  afterEach(() => database.close());

  it("dispatches when the estimate is within budget", async () => {
    const events = new RuntimeEventBus();
    const input = "a".repeat(40);
    const provider = new FakeModelProvider({
      text: "ok",
      usage: { measurement: "unknown" },
      billingCertainty: "billing-ambiguous",
    });
    const definition: AgentDefinition = {
      ...primaryAgentDefinition,
      contextTokenBudget: Number(estimateFor(input)),
    };
    const runtime = buildRuntime(database, events, definition, provider);
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input,
    });
    await terminalOf(events, admitted.runId);
    expect(provider.requests).toHaveLength(1);
    expect(
      events.snapshot().some((event) => event.eventName === "run.completed"),
    ).toBe(true);
  });

  it("fails typed before dispatch when the estimate exceeds budget", async () => {
    const events = new RuntimeEventBus();
    const input = "a".repeat(200);
    const provider = new FakeModelProvider({
      text: "ok",
      usage: { measurement: "unknown" },
      billingCertainty: "billing-ambiguous",
    });
    const definition: AgentDefinition = {
      ...primaryAgentDefinition,
      contextTokenBudget: Number(estimateFor(input) - 1n),
    };
    const runtime = buildRuntime(database, events, definition, provider);
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input,
    });
    const terminal = await terminalOf(events, admitted.runId);
    expect(terminal).toBe("run.failed");
    expect(provider.requests).toHaveLength(0);
    const reservation = database
      .prepare("SELECT status FROM usage_reservations")
      .get() as { status: string } | undefined;
    expect(reservation).toBeUndefined();
    const assistantRows = database
      .prepare(
        "SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant'",
      )
      .get() as { count: number };
    expect(assistantRows.count).toBe(0);
    const failed = events
      .snapshot()
      .filter((event) => event.eventName === "run.failed");
    expect(failed).toHaveLength(1);
    // Finalization evidence exists and finalization exactly once.
    const finalizeEvents = events
      .snapshot()
      .filter((event) => event.runId === admitted.runId);
    expect(
      finalizeEvents.some((event) => event.eventName === "run.failed"),
    ).toBe(true);
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

  it("does not truncate complete exchange groups to fit the budget", async () => {
    const events = new RuntimeEventBus();
    const provider = new FakeModelProvider({
      text: "ok",
      usage: { measurement: "unknown" },
      billingCertainty: "billing-ambiguous",
    });
    const definition: AgentDefinition = {
      ...primaryAgentDefinition,
      contextTokenBudget: 1,
    };
    const runtime = buildRuntime(database, events, definition, provider);
    const admitted = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "any input at all",
    });
    const terminal = await terminalOf(events, admitted.runId);
    expect(terminal).toBe("run.failed");
    expect(provider.requests).toHaveLength(0);
  });

  it("deterministically estimates the same token count for identical unicode input", () => {
    const estimator = new HeuristicTokenEstimator();
    const a = estimator.estimate({
      instructions: [INSTRUCTIONS],
      turns: [{ role: "user", text: "héllo wörld 日本語" }],
    });
    const b = estimator.estimate({
      instructions: [INSTRUCTIONS],
      turns: [{ role: "user", text: "héllo wörld 日本語" }],
    });
    expect(a).toBe(b);
    expect(estimator.revision).toBe("heuristic-v1");
  });
});
