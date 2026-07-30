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
import { ToolRegistry } from "../tools/tool-registry.js";
import { createWorkspaceWriteTextTool } from "../tools/workspace-tools.js";
import { ToolRuntime } from "../tools/tool-runtime.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { AppError } from "../core/errors.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import type { WorkspaceFilesystem } from "../tools/workspace-filesystem.js";
import {
  createRuntimeAuthority,
  createSequentialIdFactory,
} from "../test/foundation-fixtures.js";
import {
  createLifecycleTrace,
  terminalFor,
} from "./agent-runtime.test-support.js";

const workspaceFilesystem = new FsSafeWorkspaceFilesystem();
const workspaceWriteTextTool =
  createWorkspaceWriteTextTool(workspaceFilesystem);

let database: AppDatabase;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
});
afterEach(() => database.close());

describe("AgentRuntime", () => {
  it("proves Agent Runtime writes tool-call transcript exclusively from normalized outcome arguments and fails closed if missing", async () => {
    const sessions = new SessionResolver(new SqliteSessionStore(database));
    const transcripts = new InMemoryTranscriptStore();
    const events = new RuntimeEventBus();
    const registry = new ToolRegistry();
    registry.register(workspaceWriteTextTool);
    registry.freeze();

    let fakeOutcomes: any[] | undefined;

    const mockToolRuntime: any = {
      onEvent: () => () => {},
      executeBatch: async () => {
        if (fakeOutcomes) return fakeOutcomes;
        return [
          {
            toolCallId: "tcall_test_1",
            toolName: "workspace.write_text",
            ordinal: 1,
            terminalState: "completed",
            ok: true,
            normalizedArguments: {
              path: "a.txt",
              content: "norm",
              mode: "create",
            },
            result: { bytesWritten: 4 },
            durationMs: 10,
          },
        ];
      },
    };

    const provider = new FakeModelProvider({
      text: "calling tool",
      toolCalls: [
        {
          id: "call_1",
          name: "workspace.write_text",
          arguments: { path: "a.txt", content: "raw", mode: "create" },
        },
      ],
      usage: {
        providerTotalTokens: 10n,
        inputTokens: 5n,
        outputTokens: 5n,
        measurement: "provider-exact",
      },
      billingCertainty: "actual-known",
    });

    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions,
      transcripts,
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      provider,
      usageBudgetGate: new UsageBudgetGate(database, [], []),
      toolRuntime: mockToolRuntime,
      toolRegistry: registry,
      workspacePolicy: new WorkspacePolicy(workspaceFilesystem),
      workspaceRoot: process.cwd(),
    });

    const run = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Write file",
    });

    await terminalFor(events, run.runId);

    const session = await sessions.resolve({
      kind: "main",
      agentId: "primary",
    });
    const page = await transcripts.readPage(session.sessionId, { limit: 100 });
    const toolCallEntry = page.entries.find(
      (e) => e.type === "tool-call",
    ) as any;
    expect(toolCallEntry).toBeDefined();
    expect(toolCallEntry.arguments).toEqual({
      path: "a.txt",
      content: "norm",
      mode: "create",
    }); // equal to normalized, NOT raw "raw"
    expect(toolCallEntry.arguments).not.toEqual({
      path: "a.txt",
      content: "raw",
      mode: "create",
    });
    const successfulToolCalls = page.entries.filter(
      (e) => e.type === "tool-call",
    );
    const successfulToolResults = page.entries.filter(
      (e) => e.type === "tool-result",
    );
    expect(successfulToolCalls).toHaveLength(8);
    expect(successfulToolResults).toHaveLength(8);
    expect(
      successfulToolResults.every((result) =>
        successfulToolCalls.some(
          (call) => call.toolCallId === result.toolCallId,
        ),
      ),
    ).toBe(true);
    expect(
      page.entries.filter((e) => e.type === "message" && e.role === "user"),
    ).toHaveLength(1);

    // Now test invariant failure path: admitted outcome missing normalizedArguments
    fakeOutcomes = [
      {
        toolCallId: "tcall_test_2",
        toolName: "workspace.write_text",
        ordinal: 1,
        terminalState: "completed",
        ok: true,
        // missing normalizedArguments!
        result: { bytesWritten: 4 },
        durationMs: 10,
      },
    ];

    const initialEntriesCount = page.entries.length;

    const badRun = await runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "Bad tool run",
    });

    const badTerminal = await terminalFor(events, badRun.runId);
    expect(badTerminal.eventName).toBe("run.failed");

    const pageAfterBad = await transcripts.readPage(session.sessionId, {
      limit: 100,
    });
    // No new tool-call or tool-result transcript batch committed in invariant failure path!
    const newToolCalls = pageAfterBad.entries.filter(
      (e, idx) => idx >= initialEntriesCount && e.type === "tool-call",
    );
    expect(newToolCalls).toHaveLength(0);
    const newToolResults = pageAfterBad.entries.filter(
      (e, idx) => idx >= initialEntriesCount && e.type === "tool-result",
    );
    const newUserMessages = pageAfterBad.entries.filter(
      (e, idx) =>
        idx >= initialEntriesCount && e.type === "message" && e.role === "user",
    );
    expect(newToolResults).toHaveLength(0);
    expect(newUserMessages).toHaveLength(0);
  });

  it.each([
    [
      "unknown tool",
      "unregistered.tool",
      { path: "raw-unknown.txt", content: "raw", mode: "create" },
    ],
    [
      "schema-invalid arguments",
      "workspace.write_text",
      {
        path: "raw-invalid.txt",
        content: "raw",
        mode: "create",
        unsupported: true,
      },
    ],
  ] as const)(
    "commits no normal transcript pair for %s",
    async (_caseName, toolName, arguments_) => {
      const sessions = new SessionResolver(new SqliteSessionStore(database));
      const transcripts = new InMemoryTranscriptStore();
      const events = new RuntimeEventBus();
      const registry = new ToolRegistry();
      registry.register(workspaceWriteTextTool);
      registry.freeze();
      const idFactory = createSequentialIdFactory();
      const toolRuntime = new ToolRuntime(
        registry,
        new WorkspacePolicy(workspaceFilesystem),
        new ApprovalCoordinator(idFactory, 5000),
      );
      const provider = new FakeModelProvider({
        text: "calling rejected tool",
        toolCalls: [
          { id: "call_rejected", name: toolName, arguments: arguments_ },
        ],
        usage: {
          providerTotalTokens: 10n,
          inputTokens: 5n,
          outputTokens: 5n,
          measurement: "provider-exact",
        },
        billingCertainty: "actual-known",
      });
      const runtime = new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions,
        transcripts,
        runs: new SqliteRunStore(database),
        journal: new SqliteRunJournalStore(database),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(database, [], []),
        toolRuntime,
        toolRegistry: registry,
        workspacePolicy: new WorkspacePolicy(workspaceFilesystem),
        workspaceRoot: process.cwd(),
      });

      const run = await runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: `Rejected ${toolName}`,
      });
      const terminal = await terminalFor(events, run.runId);
      expect(terminal.eventName).toBe("run.failed");

      const session = await sessions.resolve({
        kind: "main",
        agentId: "primary",
      });
      const page = await transcripts.readPage(session.sessionId, {
        limit: 100,
      });
      const userMessages = page.entries.filter(
        (entry) => entry.type === "message" && entry.role === "user",
      );
      const toolCalls = page.entries.filter(
        (entry) => entry.type === "tool-call",
      );
      const toolResults = page.entries.filter(
        (entry) => entry.type === "tool-result",
      );
      expect(userMessages).toHaveLength(0);
      expect(toolCalls).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
      expect(
        page.entries.filter(
          (entry) => entry.type === "tool-call" && entry.toolName === toolName,
        ),
      ).toHaveLength(0);
      expect(page.entries.every((entry) => entry.type === "message")).toBe(
        true,
      );
    },
  );

  describe("G8 no automatic replay integration", () => {
    it("halts run loop on uncertain tool failure without model retry or tool replay", async () => {
      const sessions = new SessionResolver(new SqliteSessionStore(database));
      const transcripts = new InMemoryTranscriptStore();
      const events = new RuntimeEventBus();
      const trace = createLifecycleTrace(events);
      const ids = createSequentialIdFactory();

      let modelProviderCalls = 0;
      let toolExecutions = 0;
      let toolEffects = 0;

      const customFilesystem: WorkspaceFilesystem = {
        preflight: async () => undefined,
        list: async () => [],
        readTextChunk: async () => ({
          text: "",
          bytesRead: 0,
          fileSizeBytes: 0,
        }),
        inspectTextForWrite: async () => ({ priorState: "none" }),
        createText: async () => {
          toolExecutions++;
          toolEffects++;
          throw new AppError(
            "TOOL_IMPLEMENTATION_FAILED",
            "side effect failure",
          );
        },
        writeText: async () => {
          toolExecutions++;
          toolEffects++;
          throw new AppError(
            "TOOL_IMPLEMENTATION_FAILED",
            "side effect failure",
          );
        },
      };

      const registry = new ToolRegistry();
      registry.register(createWorkspaceWriteTextTool(customFilesystem));
      registry.freeze();

      const approvals = new ApprovalCoordinator(ids);
      approvals.onRequest((binding) =>
        approvals.resolveApproval(
          binding.approvalId,
          binding.runId,
          "allow-once",
        ),
      );

      const policy = new WorkspacePolicy(customFilesystem);
      const toolRuntime = new ToolRuntime(registry, policy, approvals);

      const provider = new FakeModelProvider({
        text: "requesting write",
        toolCalls: [
          {
            id: "call_g8_integ",
            name: "workspace.write_text",
            arguments: { path: "a.txt", content: "x", mode: "create" },
          },
        ],
        usage: {
          providerTotalTokens: 10n,
          inputTokens: 5n,
          outputTokens: 5n,
          measurement: "provider-exact",
        },
        billingCertainty: "actual-known",
      });

      const origExecute = provider.execute.bind(provider);
      provider.execute = async (params, signal) => {
        modelProviderCalls++;
        return origExecute(params, signal);
      };

      const runs = new SqliteRunStore(database);
      const attempts = new SqliteAttemptStore(database);
      const runtime = new AgentRuntime({
        ...createRuntimeAuthority(),
        sessions,
        transcripts,
        runs,
        attempts,
        journal: new SqliteRunJournalStore(database),
        events,
        lanes: new SessionRunLaneCoordinator(1),
        provider,
        usageBudgetGate: new UsageBudgetGate(database, [], []),
        toolRuntime,
        toolRegistry: registry,
        workspacePolicy: policy,
        workspaceRoot: process.cwd(),
        lifecycleProbe: trace.probe,
      });

      const run = await runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "Run write text",
      });

      const terminalEvent = await terminalFor(events, run.runId);
      expect(terminalEvent.eventName).toBe("run.failed");

      const runRecord = await runs.get(run.runId);
      expect(runRecord?.status).toBe("failed");
      expect(runRecord?.terminalCode).toBe("TOOL_OUTCOME_UNCERTAIN");

      expect(modelProviderCalls).toBe(1);
      expect(toolExecutions).toBe(1);
      expect(toolEffects).toBe(1);

      const runSteps = trace.steps
        .filter((entry) => entry.runId === run.runId)
        .map((entry) => entry.step);
      const stepCount = (step: string) =>
        runSteps.filter((val) => val === step).length;

      expect(stepCount("checkpoint.decision.fail")).toBe(1);
      expect(stepCount("checkpoint.decision.complete")).toBe(0);
      expect(stepCount("checkpoint.decision.cancel")).toBe(0);

      const runEvents = events.snapshot().filter((e) => e.runId === run.runId);
      const eventCount = (eventName: string) =>
        runEvents.filter((e) => e.eventName === eventName).length;

      expect(eventCount("tool.requested")).toBe(1);
      expect(eventCount("tool.started")).toBe(1);
      expect(eventCount("tool.failed")).toBe(1);
      expect(eventCount("tool.completed")).toBe(0);
      expect(eventCount("tool.cancelled")).toBe(0);

      expect(eventCount("attempt.started")).toBe(1);

      const attemptRows = database
        .prepare(
          "SELECT attempt_id, run_id, status, terminal_code FROM attempts WHERE run_id = ?",
        )
        .all(run.runId) as Array<{
        attempt_id: string;
        run_id: string;
        status: string;
        terminal_code: string;
      }>;

      expect(attemptRows).toHaveLength(1);
      expect(attemptRows[0]!.run_id).toBe(run.runId);
      expect(attemptRows[0]!.status).toBe("failed");
      expect(attemptRows[0]!.terminal_code).toBe("TOOL_OUTCOME_UNCERTAIN");

      const terminalEvents = runEvents.filter(
        (e) =>
          e.eventName === "run.completed" ||
          e.eventName === "run.failed" ||
          e.eventName === "run.cancelled",
      );
      expect(terminalEvents).toHaveLength(1);
    });
  });
});
