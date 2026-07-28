import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../agents/agent-runtime.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { SqliteTranscriptStore } from "../sessions/sqlite-transcript-store.js";
import {
  createRuntimeAuthority,
  createTemporaryDatabase,
} from "../test/foundation-fixtures.js";
import { UsageBudgetGate } from "../usage/usage-budget-gate.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { GeminiInteractionsProvider } from "./gemini-interactions-provider.js";

describe("GeminiInteractionsProvider", () => {
  it("uses Interactions with store=false and never sends previous interaction state", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return {
            output_text: "Hi",
            usage: {
              total_tokens: 2,
              total_input_tokens: 1,
              total_output_tokens: 1,
            },
          };
        },
      },
    } as never);
    const result = await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: ["rule"],
        turns: [{ role: "user", text: "Hello" }],
      },
      new AbortController().signal,
    );
    expect(captured).toMatchObject({ model: "gemini-3.5-flash", store: false });
    expect(captured).toMatchObject({
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    expect(captured).not.toHaveProperty("previous_interaction_id");
    expect(result.text).toBe("Hi");
  });
  it("classifies a Gemini 429 as not billable", async () => {
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => {
          throw { status: 429 };
        },
      },
    } as never);
    await expect(
      provider.execute(
        {
          modelCallId: "call",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          instructions: [],
          turns: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ billingCertainty: "not-billable" });
  });
  it("projects opaque local thought signatures without provider-hosted continuation", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return { output_text: "Hi", usage_metadata: {} };
        },
      },
    } as never);
    await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: [],
        turns: [{ role: "user", text: "Hello" }],
        continuations: [
          {
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-A",
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("opaque-signature"),
          },
        ],
      },
      new AbortController().signal,
    );
    expect(captured).toMatchObject({
      input: expect.arrayContaining([
        { type: "thought", signature: "opaque-signature" },
      ]),
    });
    expect(captured).not.toHaveProperty("previous_interaction_id");
  });

  it("projects multiple opaque continuations in request order", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return { output_text: "Hi", usage_metadata: {} };
        },
      },
    } as never);

    await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: [],
        turns: [],
        continuations: [
          {
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-1",
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("first-signature"),
          },
          {
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: "model-call-2",
            version: "gemini-thought-signature-v1",
            payload: new TextEncoder().encode("second-signature"),
          },
        ],
      },
      new AbortController().signal,
    );

    expect(captured).toMatchObject({
      store: false,
      input: [
        { type: "thought", signature: "first-signature" },
        { type: "thought", signature: "second-signature" },
      ],
    });
    expect(captured).not.toHaveProperty("previous_interaction_id");
  });

  it.each([
    ["no usage", undefined],
    ["empty usage", {}],
    ["missing output usage", { total_tokens: 2, total_input_tokens: 1 }],
    [
      "non-finite usage",
      { total_tokens: Infinity, total_input_tokens: 1, total_output_tokens: 1 },
    ],
    [
      "negative usage",
      { total_tokens: -1, total_input_tokens: 1, total_output_tokens: 1 },
    ],
    [
      "fractional usage",
      { total_tokens: 2.5, total_input_tokens: 1, total_output_tokens: 1 },
    ],
    [
      "numeric string usage",
      { total_tokens: "2", total_input_tokens: 1, total_output_tokens: 1 },
    ],
    [
      "inconsistent total usage",
      { total_tokens: 9, total_input_tokens: 6, total_output_tokens: 4 },
    ],
  ])(
    "marks a dispatched successful response with %s as billing ambiguous",
    async (_name, usage) => {
      const provider = new GeminiInteractionsProvider("not-used", {
        interactions: { create: async () => ({ output_text: "Hi", usage }) },
      } as never);
      await expect(
        provider.execute(
          {
            modelCallId: "call",
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            instructions: [],
            turns: [],
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        billingCertainty: "billing-ambiguous",
        usage: { measurement: "unknown" },
      });
    },
  );

  it.each([
    [
      "exact total",
      { total_tokens: 10, total_input_tokens: 6, total_output_tokens: 4 },
    ],
    [
      "total with native extra categories",
      { total_tokens: 11, total_input_tokens: 6, total_output_tokens: 4 },
    ],
    [
      "all-zero usage",
      { total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0 },
    ],
  ])("marks %s as actual known", async (_name, usage) => {
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: { create: async () => ({ output_text: "Hi", usage }) },
    } as never);
    await expect(
      provider.execute(
        {
          modelCallId: "call",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          instructions: [],
          turns: [],
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ billingCertainty: "actual-known" });
  });

  it("normalizes a native thought signature without exposing it as text", async () => {
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => ({
          output_text: "Visible answer",
          usage: {
            total_tokens: 3,
            total_input_tokens: 1,
            total_output_tokens: 2,
          },
          steps: [
            { type: "thought", signature: "opaque-native-signature" },
            {
              type: "thought_signature",
              signature: "opaque-native-signature-2",
            },
          ],
        }),
      },
    } as never);
    const result = await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: [],
        turns: [],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      text: "Visible answer",
      billingCertainty: "actual-known",
      requiresContinuation: true,
      continuation: { version: "gemini-thought-signature-v1" },
    });
    expect(result.text).not.toContain("opaque-native-signature");
    expect(new TextDecoder().decode(result.continuation?.payload)).toBe(
      "opaque-native-signature-2",
    );
  });

  it("fails closed in the runtime when a native thought step has no signature", async () => {
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => ({
          output_text: "Visible answer",
          usage: {
            total_tokens: 3,
            total_input_tokens: 1,
            total_output_tokens: 2,
          },
          steps: [{ type: "thought" }],
        }),
      },
    } as never);
    const result = await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: [],
        turns: [],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ requiresContinuation: true });
    expect(result.continuation).toBeUndefined();
  });

  it("persists a native response sidecar and projects it after SQLite reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          call += 1;
          return call === 1
            ? {
                output_text: "First answer",
                usage: {
                  total_tokens: 3,
                  total_input_tokens: 1,
                  total_output_tokens: 2,
                },
                steps: [
                  { type: "thought", signature: "opaque-reopen-signature" },
                ],
              }
            : {
                output_text: "Second answer",
                usage: {
                  total_tokens: 4,
                  total_input_tokens: 2,
                  total_output_tokens: 2,
                },
              };
        },
      },
    } as never);
    const build = (database: AppDatabase) => {
      const events = new RuntimeEventBus();
      const terminal = new Promise<void>((resolve) =>
        events.subscribe((event) => {
          if (
            event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled"
          )
            resolve();
        }),
      );
      return {
        terminal,
        runtime: new AgentRuntime({
          ...createRuntimeAuthority(),
          sessions: new SessionResolver(new SqliteSessionStore(database)),
          transcripts: new SqliteTranscriptStore(database),
          runs: new SqliteRunStore(database),
          journal: new SqliteRunJournalStore(database),
          events,
          lanes: new SessionRunLaneCoordinator(1),
          provider,
          usageBudgetGate: new UsageBudgetGate(database, [], []),
        }),
      };
    };
    const first = build(temporary.database);
    await first.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "First",
    });
    await first.terminal;
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const second = build(reopened);
    await second.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Second",
    });
    await second.terminal;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ store: false });
    expect(requests[1]).not.toHaveProperty("previous_interaction_id");
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        { type: "thought", signature: "opaque-reopen-signature" },
      ]),
    );
    const session = await new SessionResolver(
      new SqliteSessionStore(reopened),
    ).resolve({ kind: "main", agentId: "primary" });
    const persisted = await new SqliteTranscriptStore(
      reopened,
    ).readContinuation(session.sessionId, 2);
    expect(new TextDecoder().decode(persisted?.payload)).toBe(
      "opaque-reopen-signature",
    );
    reopened.close();
    temporary.close();
  });

  it("keeps an adapter-normalized unknown usage reservation uncertain and cap-blocking", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    let calls = 0;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => {
          calls += 1;
          return { output_text: "answer", usage: {} };
        },
      },
    } as never);
    const events = new RuntimeEventBus();
    const waitTerminal = () =>
      new Promise<void>((resolve) => {
        const unsubscribe = events.subscribe((event) => {
          if (
            event.eventName === "run.completed" ||
            event.eventName === "run.failed"
          ) {
            unsubscribe();
            resolve();
          }
        });
      });
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(new SqliteSessionStore(database)),
      transcripts: new SqliteTranscriptStore(database),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(2),
      provider,
      usageBudgetGate: new UsageBudgetGate(
        database,
        [{ id: "cap", window: "day", maxTokens: 5n, enabled: true }],
        [],
      ),
    });
    const firstDone = waitTerminal();
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "12345",
    });
    await firstDone;
    expect(
      (
        database.prepare("SELECT status FROM usage_reservations").get() as {
          status: string;
        }
      ).status,
    ).toBe("uncertain");
    const secondDone = waitTerminal();
    await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "12345",
    });
    await secondDone;
    expect(calls).toBe(1);
    database.close();
  });

  it("keeps inconsistent native usage uncertain and cap-blocking after SQLite reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    let calls = 0;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => {
          calls += 1;
          return {
            output_text: "answer",
            usage: {
              total_tokens: 9,
              total_input_tokens: 6,
              total_output_tokens: 4,
            },
          };
        },
      },
    } as never);
    const policies = [
      { id: "cap", window: "day" as const, maxTokens: 5n, enabled: true },
    ];
    const build = (database: AppDatabase) => {
      const events = new RuntimeEventBus();
      const terminal = new Promise<void>((resolve) =>
        events.subscribe((event) => {
          if (
            event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled"
          )
            resolve();
        }),
      );
      return {
        terminal,
        runtime: new AgentRuntime({
          ...createRuntimeAuthority(),
          sessions: new SessionResolver(new SqliteSessionStore(database)),
          transcripts: new SqliteTranscriptStore(database),
          runs: new SqliteRunStore(database),
          journal: new SqliteRunJournalStore(database),
          events,
          lanes: new SessionRunLaneCoordinator(1),
          provider,
          usageBudgetGate: new UsageBudgetGate(database, policies, []),
        }),
      };
    };
    const first = build(temporary.database);
    await first.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "12345",
    });
    await first.terminal;
    expect(
      temporary.database.prepare("SELECT status FROM usage_reservations").get(),
    ).toEqual({ status: "uncertain" });
    expect(
      temporary.database
        .prepare("SELECT outcome, provider_total_tokens FROM usage_records")
        .get(),
    ).toEqual({ outcome: "uncertain", provider_total_tokens: null });
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const second = build(reopened);
    await second.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "12345",
    });
    await second.terminal;
    expect(calls).toBe(1);
    expect(
      reopened.prepare("SELECT status FROM usage_reservations").all(),
    ).toEqual([{ status: "uncertain" }]);
    reopened.close();
    temporary.close();
  });
});
