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
import { FakeModelProvider } from "../models/fake-model-provider.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { toGatewayRuntimeEvent } from "../gateway/runtime-event-translation.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import {
  createRuntimeAuthority,
  createTemporaryDatabase,
} from "../test/foundation-fixtures.js";
import {
  collectTerminalEvents,
  terminalFor,
} from "./agent-runtime.test-support.js";

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
});
