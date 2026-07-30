import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { AppError } from "../core/errors.js";
import {
  createAgentId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type { ToolExecutionContext, ToolRegistration } from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import { createWorkspaceWriteTextTool } from "./workspace-tools.js";
import type { WorkspaceFilesystem } from "./workspace-filesystem.js";
import { createDeferred } from "./tool-runtime.test-support.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  describe("M3-R3-4 certainty evidence", () => {
    function writeRuntime(
      filesystem: WorkspaceFilesystem,
      ids = createSequentialIdFactory(),
      hooks?: import("./tool-runtime.js").ToolRuntimeTestHooks,
    ) {
      const registry = new ToolRegistry();
      registry.register(createWorkspaceWriteTextTool(filesystem));
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(
        registry,
        new WorkspacePolicy(filesystem),
        approvals,
        undefined,
        hooks,
      );
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r34"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      approvals.onRequest((binding) =>
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        ),
      );
      return { runtime, context };
    }

    it("G3 classifies production workspace inspection failure before the possible-effect marker", async () => {
      const calls: string[] = [];
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined,
        list: async () => [],
        readTextChunk: async () => ({
          text: "",
          bytesRead: 0,
          fileSizeBytes: 0,
        }),
        inspectTextForWrite: async () => {
          calls.push("inspect");
          throw new AppError("TOOL_IMPLEMENTATION_FAILED", "inspection failed");
        },
        createText: async () => {
          calls.push("create");
        },
        writeText: async () => {
          calls.push("write");
        },
      };
      const { runtime, context } = writeRuntime(filesystem);
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r34_g3"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments: { path: "a.txt", content: "x", mode: "write" },
          },
        ],
        context,
      );
      expect(calls).toEqual(["inspect"]);
      expect(outcome).toMatchObject({
        terminalState: "failed-before-known-side-effect",
        error: { code: "TOOL_IMPLEMENTATION_FAILED" },
      });
      expect(events.filter((event) => event === "tool.started")).toHaveLength(
        1,
      );
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events).not.toContain("tool.completed");
    });

    it("G4 classifies production workspace mutation failure as uncertain with a safe cause", async () => {
      let effects = 0;
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined,
        list: async () => [],
        readTextChunk: async () => ({
          text: "",
          bytesRead: 0,
          fileSizeBytes: 0,
        }),
        inspectTextForWrite: async () => ({ priorState: "none" }),
        createText: async () => {
          effects++;
          throw new AppError("TOOL_IMPLEMENTATION_FAILED", "write failed");
        },
        writeText: async () => {
          effects++;
          throw new AppError("TOOL_IMPLEMENTATION_FAILED", "write failed");
        },
      };
      const { runtime, context } = writeRuntime(filesystem);
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r34_g4"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments: { path: "a.txt", content: "x", mode: "create" },
          },
        ],
        context,
      );
      expect(effects).toBe(1);
      expect(outcome).toMatchObject({
        terminalState: "outcome-uncertain",
        error: {
          code: "TOOL_OUTCOME_UNCERTAIN",
          causeCode: "TOOL_IMPLEMENTATION_FAILED",
        },
      });
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events).not.toContain("tool.completed");
    });

    describe("G5 post-effect cancellation", () => {
      it("classifies post-side-effect parent cancellation as outcome-uncertain", async () => {
        let executions = 0;
        let effectCount = 0;
        const parentController = new AbortController();
        let childAbortedInImpl = false;

        const registry = new ToolRegistry();
        registry.register({
          name: "test.write_side_effect",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "side effect tool",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            executions++;
            context.markIoStarted();
            context.markSideEffectPossible();
            effectCount++;
            parentController.abort();
            childAbortedInImpl = Boolean(context.signal?.aborted);
            throw new Error("interrupted side effect");
          },
        });
        registry.freeze();

        const ids = createSequentialIdFactory();
        const approvals = new ApprovalCoordinator(ids);
        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(registry, policy, approvals);
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g5"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest((binding) =>
          approvals.resolveApproval(
            binding.approvalId,
            context.runId,
            "allow-once",
          ),
        );

        const events: string[] = [];
        runtime.onEvent((e) => events.push(e.type));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g5"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "test.write_side_effect",
              rawArguments: { path: "a.txt" },
            },
          ],
          context,
          parentController.signal,
        );

        expect(executions).toBe(1);
        expect(effectCount).toBe(1);
        expect(childAbortedInImpl).toBe(true);
        expect(outcome).toMatchObject({
          terminalState: "outcome-uncertain",
          error: {
            code: "TOOL_OUTCOME_UNCERTAIN",
            causeCode: "TOOL_CANCELLED",
          },
        });
        expect(events.filter((t) => t === "tool.failed")).toHaveLength(1);
        expect(events.filter((t) => t === "tool.cancelled")).toHaveLength(0);
        expect(events.filter((t) => t === "tool.completed")).toHaveLength(0);
      });
    });

    describe("G6 post-effect timeout", () => {
      it("classifies post-side-effect timeout as outcome-uncertain using fake timers", async () => {
        vi.useFakeTimers();
        try {
          let executions = 0;
          let effectCount = 0;
          let childAbortedInImpl = false;

          const registry = new ToolRegistry();
          registry.register({
            name: "test.timeout_side_effect",
            descriptorVersion: "1.0.0",
            owningModule: "test",
            description: "timeout side effect tool",
            argumentSchema: Type.Object({ path: Type.String() }),
            resultSchema: Type.Object({ ok: Type.Boolean() }),
            effectClassification: "side-effecting",
            sensitivityClassification: "none",
            executionTarget: "workspace",
            sandboxRequirement: "host-workspace-v1",
            timeoutMs: 1000,
            cancellationSupport: true,
            concurrencyTrait: "sequential",
            idempotencyTrait: false,
            approvalSummaryRenderer: () => "timeout write",
            redactionRules: [],
            inputLimits: {},
            outputLimits: {},
            progressFingerprintVersion: "1.0.0",
            execute: async (_args, context) => {
              executions++;
              context.markIoStarted();
              context.markSideEffectPossible();
              effectCount++;
              vi.advanceTimersByTime(2000);
              childAbortedInImpl = Boolean(context.signal?.aborted);
              throw new Error("timed out side effect");
            },
          });
          registry.freeze();

          const ids = createSequentialIdFactory();
          const approvals = new ApprovalCoordinator(ids);
          const policy = {
            evaluateInvocation: async (_t: any, args: any) => ({
              decision: "require-approval",
              reason: "approval required",
              policyProfile: "test",
              policyVersion: "1.0.0",
              targetPath: args.path,
              policyConstraints: {},
              redactionMetadata: {},
            }),
          } as any;
          const runtime = new ToolRuntime(registry, policy, approvals, {
            toolTimeoutMs: 1000,
          });
          const context: ToolBatchContext = {
            agentId: createAgentId("primary"),
            sessionKey: createSessionKey("agent:primary:g6"),
            sessionId: ids.nextSessionId(),
            runId: ids.nextRunId(),
            attemptId: ids.nextAttemptId(),
            modelCallId: ids.nextModelCallId(),
            workspaceRoot: "/workspace",
            sandboxProfile: "host-workspace-v1",
            totalRunToolCalls: 0,
          };
          approvals.onRequest((binding) =>
            approvals.resolveApproval(
              binding.approvalId,
              context.runId,
              "allow-once",
            ),
          );

          const events: string[] = [];
          runtime.onEvent((e) => events.push(e.type));

          const [outcome] = await runtime.executeBatch(
            [
              {
                toolCallId: createToolCallId("tcall_g6"),
                modelCallId: context.modelCallId,
                ordinal: 1,
                toolName: "test.timeout_side_effect",
                rawArguments: { path: "a.txt" },
              },
            ],
            context,
          );

          expect(executions).toBe(1);
          expect(effectCount).toBe(1);
          expect(childAbortedInImpl).toBe(true);
          expect(outcome).toMatchObject({
            terminalState: "outcome-uncertain",
            error: {
              code: "TOOL_OUTCOME_UNCERTAIN",
              causeCode: "TOOL_EXECUTION_TIMEOUT",
            },
          });
          expect(events.filter((t) => t === "tool.failed")).toHaveLength(1);
          expect(events.filter((t) => t === "tool.completed")).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("G7 race matrix", () => {
      it("ensures exactly one terminal outcome and event across cancellation, timeout, and late markers", async () => {
        const ids = createSequentialIdFactory();
        let lateContext: ToolExecutionContext | undefined;
        const registry = new ToolRegistry();
        registry.register({
          name: "test.late_markers",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "test late markers",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "read-only",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "parallel-safe",
          idempotencyTrait: true,
          approvalSummaryRenderer: () => "read",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            context.markIoStarted();
            lateContext = context;
            return { ok: true };
          },
        });
        registry.freeze();

        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "allow",
            reason: "allowed",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(
          registry,
          policy,
          new ApprovalCoordinator(ids),
        );
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g7"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };

        const events: string[] = [];
        runtime.onEvent((e) => events.push(e.type));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_late"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.late_markers",
              rawArguments: { path: "a.txt" },
            },
          ],
          batchContext,
        );

        expect(outcome?.ok).toBe(true);
        const eventCountBeforeLate = events.length;
        const terminalEventsBeforeLate = events.filter((t) =>
          ["tool.completed", "tool.failed", "tool.cancelled"].includes(t),
        );
        expect(terminalEventsBeforeLate).toHaveLength(1);

        lateContext?.markIoStarted();
        lateContext?.markSideEffectPossible();

        expect(events.length).toBe(eventCountBeforeLate);
        const terminalEventsAfterLate = events.filter((t) =>
          ["tool.completed", "tool.failed", "tool.cancelled"].includes(t),
        );
        expect(terminalEventsAfterLate).toHaveLength(1);
      });
    });

    describe("G8 no automatic replay batch proof", () => {
      it("halts sequential execution after uncertain side-effect failure without invoking remaining batch tools", async () => {
        const ids = createSequentialIdFactory();
        let firstExecutions = 0;
        let secondExecutions = 0;
        let firstEffects = 0;

        const registry = new ToolRegistry();
        registry.register({
          name: "test.write_uncertain_1",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "write uncertain 1",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write 1",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            firstExecutions++;
            context.markIoStarted();
            context.markSideEffectPossible();
            firstEffects++;
            throw new Error("uncertain write failure");
          },
        });
        registry.register({
          name: "test.write_uncertain_2",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "write uncertain 2",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write 2",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            secondExecutions++;
            context.markIoStarted();
            return { ok: true };
          },
        });
        registry.freeze();

        const approvals = new ApprovalCoordinator(ids);
        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(registry, policy, approvals);
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g8_batch"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest((binding) =>
          approvals.resolveApproval(
            binding.approvalId,
            batchContext.runId,
            "allow-once",
          ),
        );

        const outcomes = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g8_1"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.write_uncertain_1",
              rawArguments: { path: "1.txt" },
            },
            {
              toolCallId: createToolCallId("tcall_g8_2"),
              modelCallId: batchContext.modelCallId,
              ordinal: 2,
              toolName: "test.write_uncertain_2",
              rawArguments: { path: "2.txt" },
            },
          ],
          batchContext,
        );

        expect(firstExecutions).toBe(1);
        expect(firstEffects).toBe(1);
        expect(secondExecutions).toBe(0);
        expect(outcomes[0]!.terminalState).toBe("outcome-uncertain");
        expect(outcomes[1]!.terminalState).toBe("not-started");
      });
    });
  });

  describe("G2 — Runtime marker authority", () => {
    it("G2 emits tool.started only on the first accepted I/O marker and ignores duplicate or late markers", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let startedCount = 0;
      let capturedContext: ToolExecutionContext | undefined;

      const g2Tool: ToolRegistration<{ path: string }, { ok: boolean }> = {
        name: "test.g2_marker_tool",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "G2 marker test tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ ok: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "host",
        sandboxRequirement: "none",
        timeoutMs: 30000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1.0.0",
        approvalSummaryRenderer: () => "G2 test tool summary",
        execute: async (_args, context) => {
          capturedContext = context;
          expect(startedCount).toBe(0);
          context.markIoStarted();
          expect(startedCount).toBe(1);
          context.markIoStarted();
          expect(startedCount).toBe(1);
          context.markSideEffectPossible();
          expect(startedCount).toBe(1);
          return { ok: true };
        },
      };

      registry.register(g2Tool);
      registry.freeze();

      const policy = {
        evaluateInvocation: async (_t: any, args: any) => ({
          decision: "require-approval",
          reason: "approval required",
          policyProfile: "test",
          policyVersion: "1.0.0",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;

      const approvalCoordinator = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:g2_batch"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) =>
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        ),
      );

      const events: Array<{ type: string; data?: Record<string, unknown> }> =
        [];
      runtime.onEvent((e) => {
        if (e.type === "tool.started") {
          startedCount++;
        }
        events.push(e);
      });

      const outcomes = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g2_1"),
            modelCallId: batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g2_marker_tool",
            rawArguments: { path: "test.txt" },
          },
        ],
        batchContext,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("completed");
      expect(outcome.ok).toBe(true);

      const completedEvents = events.filter((e) => e.type === "tool.completed");
      const failedEvents = events.filter((e) => e.type === "tool.failed");
      const cancelledEvents = events.filter((e) => e.type === "tool.cancelled");

      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(cancelledEvents).toHaveLength(0);

      expect(capturedContext).toBeDefined();
      const eventCountBeforeLate = events.length;

      capturedContext!.markIoStarted();
      capturedContext!.markSideEffectPossible();

      expect(events.length).toBe(eventCountBeforeLate);
      expect(startedCount).toBe(1);
      expect(completedEvents).toHaveLength(1);
      expect(outcome.terminalState).toBe("completed");
    });
  });

  describe("G6 — Timeout followed by late successful resolution", () => {
    it("G6 seals an uncertain timeout outcome and suppresses late implementation success", async () => {
      vi.useFakeTimers();
      try {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let executeCount = 0;
        let effectCount = 0;

        const effectReached = createDeferred<void>();
        const releaseImplementation = createDeferred<{ ok: boolean }>();
        let capturedContext: ToolExecutionContext | undefined;

        const g6Tool: ToolRegistration<{ path: string }, { ok: boolean }> = {
          name: "test.g6_timeout_tool",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "G6 timeout test tool",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "host",
          sandboxRequirement: "none",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          approvalSummaryRenderer: () => "G6 test tool summary",
          execute: async (_args, context) => {
            capturedContext = context;
            executeCount += 1;
            context.markIoStarted();
            context.markSideEffectPossible();
            effectCount += 1;
            effectReached.resolve();
            return await releaseImplementation.promise;
          },
        };

        registry.register(g6Tool);
        registry.freeze();

        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;

        const approvalCoordinator = new ApprovalCoordinator(ids);
        const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g6_batch"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };

        approvalCoordinator.onRequest((binding) =>
          approvalCoordinator.resolveApproval(
            binding.approvalId,
            batchContext.runId,
            "allow-once",
          ),
        );

        const events: Array<{ type: string; data?: Record<string, unknown> }> =
          [];
        runtime.onEvent((e) => events.push(e));

        const batchPromise = runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g6_1"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g6_timeout_tool",
              rawArguments: { path: "test.txt" },
            },
          ],
          batchContext,
        );

        await effectReached.promise;
        await vi.advanceTimersByTimeAsync(5000);

        expect(capturedContext?.signal?.aborted).toBe(true);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;

        expect(executeCount).toBe(1);
        expect(effectCount).toBe(1);
        expect(outcome.terminalState).toBe("outcome-uncertain");
        expect(outcome.error?.code).toBe("TOOL_OUTCOME_UNCERTAIN");
        expect(outcome.error?.causeCode).toBe("TOOL_EXECUTION_TIMEOUT");

        const failedEvents = events.filter((e) => e.type === "tool.failed");
        const completedEvents = events.filter(
          (e) => e.type === "tool.completed",
        );
        const cancelledEvents = events.filter(
          (e) => e.type === "tool.cancelled",
        );

        expect(failedEvents).toHaveLength(1);
        expect(completedEvents).toHaveLength(0);
        expect(cancelledEvents).toHaveLength(0);
        expect(
          failedEvents.length + completedEvents.length + cancelledEvents.length,
        ).toBe(1);

        const eventCountBeforeRelease = events.length;

        releaseImplementation.resolve({ ok: true });
        await vi.runAllTimersAsync();

        expect(executeCount).toBe(1);
        expect(effectCount).toBe(1);
        expect(events.length).toBe(eventCountBeforeRelease);
        expect(events.filter((e) => e.type === "tool.failed")).toHaveLength(1);
        expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(
          0,
        );
        expect(
          events.filter(
            (e) =>
              e.type === "tool.failed" ||
              e.type === "tool.completed" ||
              e.type === "tool.cancelled",
          ),
        ).toHaveLength(1);
        expect(outcome.terminalState).toBe("outcome-uncertain");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("G7 first-terminal-wins race matrix", () => {
    function setupRaceHarness(
      executeFn: (context: ToolExecutionContext) => Promise<{ ok: boolean }>,
      options?: { timeoutMs?: number },
    ) {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executeCount = 0;
      const implementationEntered = createDeferred<void>();

      const readOnlyTool: ToolRegistration<{ path: string }, { ok: boolean }> =
        {
          name: "test.g7_race_tool",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "G7 race matrix tool",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "read-only",
          sensitivityClassification: "none",
          executionTarget: "host",
          sandboxRequirement: "none",
          timeoutMs: options?.timeoutMs ?? 5000,
          cancellationSupport: true,
          concurrencyTrait: "parallel-safe",
          idempotencyTrait: true,
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          approvalSummaryRenderer: () => "G7 race tool summary",
          execute: async (_args, context) => {
            executeCount += 1;
            context.markIoStarted();
            implementationEntered.resolve();
            return await executeFn(context);
          },
        };

      registry.register(readOnlyTool);
      registry.freeze();

      const policy = {
        evaluateInvocation: async (_t: any, args: any) => ({
          decision: "allow",
          reason: "read-only allowed",
          policyProfile: "test",
          policyVersion: "1.0.0",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;

      const approvalCoordinator = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:g7_batch"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      const events: Array<{ type: string; data?: Record<string, unknown> }> =
        [];
      runtime.onEvent((e) => events.push(e));

      return {
        ids,
        runtime,
        batchContext,
        events,
        implementationEntered,
        getExecuteCount: () => executeCount,
      };
    }

    function expectTerminalEvents(events: Array<{ type: string }>) {
      const completed = events.filter(
        (e) => e.type === "tool.completed",
      ).length;
      const failed = events.filter((e) => e.type === "tool.failed").length;
      const cancelled = events.filter(
        (e) => e.type === "tool.cancelled",
      ).length;
      expect(completed + failed + cancelled).toBe(1);
      return { completed, failed, cancelled };
    }

    it("1. result before parent cancellation", async () => {
      const controller = new AbortController();
      const harness = setupRaceHarness(async () => ({ ok: true }));

      const outcomes = await harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_1"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "1.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("completed");
      expect(outcome.ok).toBe(true);

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.completed).toBe(1);
      expect(terminal.failed).toBe(0);
      expect(terminal.cancelled).toBe(0);

      controller.abort();
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("completed");
    });

    it("2. parent cancellation before late result", async () => {
      const controller = new AbortController();
      const deferred = createDeferred<{ ok: boolean }>();
      const harness = setupRaceHarness(async () => await deferred.promise);

      const batchPromise = harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_2"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "2.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      await harness.implementationEntered.promise;
      expect(harness.getExecuteCount()).toBe(1);
      expect(
        harness.events.filter((e) => e.type === "tool.started"),
      ).toHaveLength(1);

      controller.abort();

      const outcomes = await batchPromise;
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_CANCELLED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.cancelled).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.failed).toBe(0);

      const eventCountBeforeLate = harness.events.length;
      deferred.resolve({ ok: true });
      await Promise.resolve();

      expect(harness.events.length).toBe(eventCountBeforeLate);
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
    });

    it("3. implementation error before parent cancellation", async () => {
      const controller = new AbortController();
      const harness = setupRaceHarness(async () => {
        throw new AppError("TOOL_IMPLEMENTATION_FAILED", "Impl error 3");
      });

      const outcomes = await harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_3"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "3.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_IMPLEMENTATION_FAILED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.failed).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.cancelled).toBe(0);

      controller.abort();
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("failed-before-known-side-effect");
    });

    it("4. parent cancellation before late implementation error", async () => {
      const controller = new AbortController();
      const deferred = createDeferred<{ ok: boolean }>();
      const harness = setupRaceHarness(async () => await deferred.promise);

      const batchPromise = harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_4"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "4.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      await harness.implementationEntered.promise;
      expect(harness.getExecuteCount()).toBe(1);
      expect(
        harness.events.filter((e) => e.type === "tool.started"),
      ).toHaveLength(1);

      controller.abort();

      const outcomes = await batchPromise;
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_CANCELLED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.cancelled).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.failed).toBe(0);

      const eventCountBeforeLate = harness.events.length;
      deferred.reject(new Error("Late error 4"));
      await Promise.resolve();

      expect(harness.events.length).toBe(eventCountBeforeLate);
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
    });

    it("5. result before timeout", async () => {
      vi.useFakeTimers();
      try {
        const harness = setupRaceHarness(async () => ({ ok: true }), {
          timeoutMs: 5000,
        });

        const outcomes = await harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_5"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "5.txt" },
            },
          ],
          harness.batchContext,
        );

        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("completed");
        expect(outcome.ok).toBe(true);

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.completed).toBe(1);
        expect(terminal.failed).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);

        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("completed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("6. timeout before late result", async () => {
      vi.useFakeTimers();
      try {
        const deferred = createDeferred<{ ok: boolean }>();
        const harness = setupRaceHarness(async () => await deferred.promise, {
          timeoutMs: 5000,
        });

        const batchPromise = harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_6"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "6.txt" },
            },
          ],
          harness.batchContext,
        );

        await harness.implementationEntered.promise;
        expect(harness.getExecuteCount()).toBe(1);
        expect(
          harness.events.filter((e) => e.type === "tool.started"),
        ).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(5000);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_EXECUTION_TIMEOUT");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        const eventCountBeforeLate = harness.events.length;
        deferred.resolve({ ok: true });
        await vi.runAllTimersAsync();

        expect(harness.events.length).toBe(eventCountBeforeLate);
        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });

    it("7. implementation error before timeout", async () => {
      vi.useFakeTimers();
      try {
        const harness = setupRaceHarness(
          async () => {
            throw new AppError("TOOL_IMPLEMENTATION_FAILED", "Impl error 7");
          },
          { timeoutMs: 5000 },
        );

        const outcomes = await harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_7"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "7.txt" },
            },
          ],
          harness.batchContext,
        );

        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_IMPLEMENTATION_FAILED");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);

        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });

    it("8. timeout before late implementation error", async () => {
      vi.useFakeTimers();
      try {
        const deferred = createDeferred<{ ok: boolean }>();
        const harness = setupRaceHarness(async () => await deferred.promise, {
          timeoutMs: 5000,
        });

        const batchPromise = harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_8"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "8.txt" },
            },
          ],
          harness.batchContext,
        );

        await harness.implementationEntered.promise;
        expect(harness.getExecuteCount()).toBe(1);
        expect(
          harness.events.filter((e) => e.type === "tool.started"),
        ).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(5000);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_EXECUTION_TIMEOUT");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        const eventCountBeforeLate = harness.events.length;
        deferred.reject(new Error("Late error 8"));
        await vi.runAllTimersAsync();

        expect(harness.events.length).toBe(eventCountBeforeLate);
        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
