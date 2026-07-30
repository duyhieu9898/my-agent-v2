import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  createAgentId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type {
  NormalizedToolRequest,
  ToolDescriptor,
  ToolExecutionContext,
  ToolRegistration,
} from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  describe("M3-R2 batch admission and bounded parallelism", () => {
    function r2Context(ids = createSequentialIdFactory()): ToolBatchContext {
      return {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r2"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
    }

    function r2Request(
      context: ToolBatchContext,
      ordinal: number,
      toolName: string,
      path: string,
    ): NormalizedToolRequest {
      return {
        toolCallId: createToolCallId(`r2_${ordinal}_${path}`),
        modelCallId: context.modelCallId,
        ordinal,
        toolName,
        rawArguments: { path },
      };
    }

    function r2Tool({
      name,
      effectClassification = "read-only",
      concurrencyTrait = "parallel-safe",
      approvalSummaryRenderer = () => "r2 approval",
      execute = async (args: Record<string, unknown>) => ({ path: args.path }),
    }: {
      name: string;
      effectClassification?: ToolRegistration["effectClassification"];
      concurrencyTrait?: ToolRegistration["concurrencyTrait"];
      approvalSummaryRenderer?: ToolRegistration["approvalSummaryRenderer"];
      execute?: ToolRegistration["execute"];
    }): ToolRegistration {
      return {
        name,
        descriptorVersion: "1",
        owningModule: "test",
        description: name,
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ path: Type.String() }),
        effectClassification,
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait,
        idempotencyTrait: effectClassification === "read-only",
        approvalSummaryRenderer,
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1",
        execute,
      };
    }

    function allowedPolicy(args: Record<string, unknown>) {
      return {
        decision: "allow",
        reason: "allowed",
        policyProfile: "r2",
        policyVersion: "1",
        targetPath: args.path as string,
        policyConstraints: {},
        redactionMetadata: {},
      };
    }

    it("normalizes a throwing approval renderer and skips later sequential calls", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let approvalsRequested = 0;
      const executions: string[] = [];
      registry.register(
        r2Tool({
          name: "test.renderer_failure",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          approvalSummaryRenderer: () => {
            throw new Error("renderer failed");
          },
          execute: async (args) => {
            executions.push(args.path as string);
            return { path: args.path };
          },
        }),
      );
      registry.register(
        r2Tool({
          name: "test.later_read",
          execute: async (args) => {
            executions.push(args.path as string);
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      approvals.onRequest(() => approvalsRequested++);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (tool: ToolDescriptor, args: any) =>
            tool.name === "test.renderer_failure"
              ? { ...allowedPolicy(args), decision: "require-approval" }
              : allowedPolicy(args),
        } as any,
        approvals,
      );
      const context = r2Context(ids);
      const batch = runtime.executeBatch(
        [
          r2Request(context, 1, "test.renderer_failure", "A"),
          r2Request(context, 2, "test.later_read", "B"),
          r2Request(context, 3, "test.later_read", "C"),
        ],
        context,
      );
      await expect(batch).resolves.toHaveLength(3);
      const outcomes = await batch;

      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual([
        "r2_1_A",
        "r2_2_B",
        "r2_3_C",
      ]);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "failed-before-known-side-effect",
        normalizedArguments: { path: "A" },
        error: { code: "TOOL_IMPLEMENTATION_FAILED" },
      });
      expect(outcomes.slice(1).map((outcome) => outcome.terminalState)).toEqual(
        ["not-started", "not-started"],
      );
      expect(approvalsRequested).toBe(0);
      expect(executions).toEqual([]);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        3,
      );
    });

    it("holds all implementation I/O and planning until every admission phase completes", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      const starts: string[] = [];
      const executionContexts: ToolExecutionContext[] = [];
      registry.register(
        r2Tool({
          name: "test.admission_read",
          execute: async (args, context) => {
            starts.push(args.path as string);
            executionContexts.push(context);
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      let releaseSecondPolicy!: () => void;
      let secondPolicyEntered!: () => void;
      const secondPolicy = new Promise<void>((resolve) => {
        releaseSecondPolicy = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        secondPolicyEntered = resolve;
      });
      const admissions: string[] = [];
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) => {
            admissions.push(args.path);
            if (args.path === "B") {
              secondPolicyEntered();
              await secondPolicy;
            }
            return allowedPolicy(args);
          },
        } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const result = runtime.executeBatch(
        [
          r2Request(context, 1, "test.admission_read", "A"),
          r2Request(context, 2, "test.admission_read", "B"),
          r2Request(context, 3, "test.admission_read", "C"),
        ],
        context,
      );

      await entered;
      expect(admissions).toEqual(["A", "B"]);
      expect(starts).toEqual([]);
      expect(events).not.toContain("tool.batch.planned");
      releaseSecondPolicy();
      await result;
      expect(admissions).toEqual(["A", "B", "C"]);
      expect(starts).toEqual(["A", "B", "C"]);
      expect(executionContexts.map((context) => context.targetPath)).toEqual([
        "A",
        "B",
        "C",
      ]);
    });

    it.each([
      ["mixed read-only and side-effecting", "mixed"],
      ["invalid arguments", "invalid"],
      ["unknown tool", "unknown"],
      ["approval-gated call", "approval"],
      ["non-parallel-safe call", "nonparallel"],
      ["policy-denied call", "denied"],
    ])("uses the sequential fallback for %s", async (_label, kind) => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let active = 0;
      let peak = 0;
      const starts: string[] = [];
      const execute = async (args: Record<string, unknown>) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(args.path as string);
        await Promise.resolve();
        active--;
        return { path: args.path };
      };
      registry.register(r2Tool({ name: "test.safe", execute }));
      registry.register(
        r2Tool({
          name: "test.side",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          execute,
        }),
      );
      registry.register(
        r2Tool({
          name: "test.sequential",
          concurrencyTrait: "sequential",
          execute,
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const context = r2Context(ids);
      approvals.onRequest((binding) => {
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        );
      });
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (tool: ToolDescriptor, args: any) => {
            if (kind === "denied") {
              return { ...allowedPolicy(args), decision: "deny" };
            }
            if (tool.name === "test.side") {
              return { ...allowedPolicy(args), decision: "require-approval" };
            }
            return allowedPolicy(args);
          },
        } as any,
        approvals,
      );
      const events: Array<{ type: string; data?: Record<string, unknown> }> =
        [];
      runtime.onEvent((event) => events.push(event));
      const requests =
        kind === "mixed"
          ? [
              r2Request(context, 1, "test.safe", "A"),
              r2Request(context, 2, "test.side", "B"),
            ]
          : kind === "invalid"
            ? [
                r2Request(context, 1, "test.safe", "A"),
                {
                  ...r2Request(context, 2, "test.safe", "B"),
                  rawArguments: {},
                },
              ]
            : kind === "unknown"
              ? [
                  r2Request(context, 1, "test.safe", "A"),
                  r2Request(context, 2, "test.unknown", "B"),
                ]
              : kind === "approval"
                ? [r2Request(context, 1, "test.side", "A")]
                : kind === "nonparallel"
                  ? [r2Request(context, 1, "test.sequential", "A")]
                  : [r2Request(context, 1, "test.safe", "A")];

      const outcomes = await runtime.executeBatch(requests, context);

      expect(
        events.find((event) => event.type === "tool.batch.planned")?.data,
      ).toMatchObject({ schedule: "sequential" });
      expect(peak).toBeLessThanOrEqual(1);
      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
      expect(outcomes).toHaveLength(requests.length);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        requests.length,
      );
      if (["invalid", "unknown", "denied"].includes(kind)) {
        expect(outcomes.at(-1)!.ok).toBe(false);
      }
      if (kind === "denied") {
        expect(starts).toEqual([]);
      }
    });

    it("returns original ordinal, id, and payload order after controlled parallel completion", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      const releases = new Map<string, () => void>();
      const entered: Array<() => void> = [];
      registry.register(
        r2Tool({
          name: "test.ordered_read",
          execute: async (args) => {
            entered.shift()?.();
            await new Promise<void>((resolve) =>
              releases.set(args.path as string, resolve),
            );
            return { path: `result-${args.path}` };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
            allowedPolicy(args),
        } as any,
        new ApprovalCoordinator(ids),
        { maxConcurrentToolCalls: 3 },
      );
      const context = r2Context(ids);
      const requests = ["A", "B", "C"].map((path, index) =>
        r2Request(context, index + 1, "test.ordered_read", path),
      );
      const allStarted = new Promise<void>((resolve) => {
        entered.push(
          () => {},
          () => {},
          resolve,
        );
      });
      const batch = runtime.executeBatch(requests, context);
      await allStarted;
      releases.get("C")!();
      await Promise.resolve();
      releases.get("A")!();
      await Promise.resolve();
      releases.get("B")!();
      const outcomes = await batch;

      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
      expect(outcomes.map((outcome) => outcome.ordinal)).toEqual([1, 2, 3]);
      expect(outcomes.map((outcome) => outcome.result)).toEqual([
        { path: "result-A" },
        { path: "result-B" },
        { path: "result-C" },
      ]);
    });

    it("returns one terminal outcome per cancelled request without implementation I/O", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register(
        r2Tool({
          name: "test.cancelled_read",
          execute: async (args) => {
            executions++;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
            allowedPolicy(args),
        } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const controller = new AbortController();
      controller.abort();
      const requests = ["A", "B", "C"].map((path, index) =>
        r2Request(context, index + 1, "test.cancelled_read", path),
      );
      const outcomes = await runtime.executeBatch(
        requests,
        context,
        controller.signal,
      );

      expect(outcomes).toHaveLength(3);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        3,
      );
      expect(outcomes.map((outcome) => outcome.terminalState)).toEqual([
        "cancelled-with-no-known-side-effect",
        "cancelled-with-no-known-side-effect",
        "cancelled-with-no-known-side-effect",
      ]);
      expect(executions).toBe(0);
    });

    it("aborts the active invocation signal on parent cancellation and suppresses late success", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let receivedSignal: AbortSignal | undefined;
      let releaseSuccess!: () => void;
      let successPathExecuted = false;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled!: () => void;
      const cancelledPromise = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const successBarrier = new Promise<void>((resolve) => {
        releaseSuccess = resolve;
      });
      registry.register(
        r2Tool({
          name: "test.abort_aware_read",
          execute: async (args, context) => {
            receivedSignal = context.signal;
            context.markIoStarted();
            started();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                cancelled();
                reject(context.signal?.reason);
              };
              context.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
              successBarrier.then(() => {
                context.signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            successPathExecuted = true;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
            allowedPolicy(args),
        } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const controller = new AbortController();
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const execution = runtime.executeBatch(
        [r2Request(context, 1, "test.abort_aware_read", "A")],
        context,
        controller.signal,
      );

      await startedPromise;
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).not.toBe(controller.signal);
      controller.abort();
      await cancelledPromise;
      const outcomes = await execution;
      releaseSuccess();
      await Promise.resolve();

      expect(receivedSignal?.aborted).toBe(true);
      expect(successPathExecuted).toBe(false);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "cancelled-with-no-known-side-effect",
        error: { code: "TOOL_CANCELLED" },
      });
      expect(events.filter((event) => event === "tool.cancelled")).toHaveLength(
        1,
      );
      expect(events.filter((event) => event === "tool.completed")).toHaveLength(
        0,
      );
    });

    it("keeps started side-effecting cancellation outcome-uncertain", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let receivedSignal: AbortSignal | undefined;
      let releaseSuccess!: () => void;
      let successPathExecuted = false;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled!: () => void;
      const cancelledPromise = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const successBarrier = new Promise<void>((resolve) => {
        releaseSuccess = resolve;
      });
      registry.register(
        r2Tool({
          name: "test.abort_aware_side_effect",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          execute: async (args, context) => {
            receivedSignal = context.signal;
            context.markIoStarted();
            context.markSideEffectPossible();
            started();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                cancelled();
                reject(context.signal?.reason);
              };
              context.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
              successBarrier.then(() => {
                context.signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            successPathExecuted = true;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) => ({
            ...allowedPolicy(args),
            decision: "require-approval",
          }),
        } as any,
        approvals,
      );
      const context = r2Context(ids);
      approvals.onRequest((binding) => {
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        );
      });
      const controller = new AbortController();
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const execution = runtime.executeBatch(
        [r2Request(context, 1, "test.abort_aware_side_effect", "A")],
        context,
        controller.signal,
      );

      await startedPromise;
      expect(events).toContain("tool.started");
      controller.abort();
      await cancelledPromise;
      const outcomes = await execution;
      releaseSuccess();
      await Promise.resolve();

      expect(receivedSignal?.aborted).toBe(true);
      expect(successPathExecuted).toBe(false);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "outcome-uncertain",
        error: {
          code: "TOOL_OUTCOME_UNCERTAIN",
          causeCode: "TOOL_CANCELLED",
        },
      });
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events.filter((event) => event === "tool.cancelled")).toHaveLength(
        0,
      );
      expect(events.filter((event) => event === "tool.completed")).toHaveLength(
        0,
      );
    });

    it("aborts the active invocation signal on timeout and suppresses late success", async () => {
      vi.useFakeTimers();
      try {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let receivedSignal: AbortSignal | undefined;
        let releaseSuccess!: () => void;
        let successPathExecuted = false;
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        });
        let cancelled!: () => void;
        const cancelledPromise = new Promise<void>((resolve) => {
          cancelled = resolve;
        });
        const successBarrier = new Promise<void>((resolve) => {
          releaseSuccess = resolve;
        });
        registry.register({
          ...r2Tool({
            name: "test.timeout_aware_read",
            execute: async (args, context) => {
              receivedSignal = context.signal;
              started();
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  cancelled();
                  reject(context.signal?.reason);
                };
                context.signal?.addEventListener("abort", onAbort, {
                  once: true,
                });
                successBarrier.then(() => {
                  context.signal?.removeEventListener("abort", onAbort);
                  resolve();
                });
              });
              successPathExecuted = true;
              return { path: args.path };
            },
          }),
          timeoutMs: 25,
        });
        registry.freeze();
        const runtime = new ToolRuntime(
          registry,
          {
            evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
              allowedPolicy(args),
          } as any,
          new ApprovalCoordinator(ids),
          { toolTimeoutMs: 25 },
        );
        const context = r2Context(ids);
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));
        const execution = runtime.executeBatch(
          [r2Request(context, 1, "test.timeout_aware_read", "A")],
          context,
        );

        await startedPromise;
        await vi.advanceTimersByTimeAsync(25);
        await cancelledPromise;
        const outcomes = await execution;
        releaseSuccess();
        await Promise.resolve();

        expect(receivedSignal?.aborted).toBe(true);
        expect(successPathExecuted).toBe(false);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          ok: false,
          terminalState: "failed-before-known-side-effect",
          error: { code: "TOOL_EXECUTION_TIMEOUT" },
        });
        expect(events.filter((event) => event === "tool.failed")).toHaveLength(
          1,
        );
        expect(
          events.filter((event) => event === "tool.completed"),
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("admits the whole batch before bounded read implementations start and preserves request order", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let active = 0;
      let peak = 0;
      const starts: string[] = [];
      const releases = new Map<string, () => void>();
      const entered: Array<() => void> = [];
      registry.register({
        name: "test.read",
        descriptorVersion: "1",
        owningModule: "test",
        description: "barrier read",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ path: Type.String() }),
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
        progressFingerprintVersion: "1",
        execute: async (args) => {
          active++;
          peak = Math.max(peak, active);
          starts.push(args.path as string);
          entered.shift()?.();
          await new Promise<void>((resolve) =>
            releases.set(args.path as string, resolve),
          );
          active--;
          return { path: args.path };
        },
      });
      registry.freeze();
      const policy = {
        evaluateInvocation: async (
          _tool: ToolDescriptor,
          args: Record<string, unknown>,
        ) => ({
          decision: "allow",
          reason: "allowed",
          policyProfile: "test",
          policyVersion: "1",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;
      const runtime = new ToolRuntime(
        registry,
        policy,
        new ApprovalCoordinator(ids),
        {
          maxConcurrentToolCalls: 2,
        },
      );
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r2"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      const requests = ["A", "B", "C"].map((path, index) => ({
        toolCallId: createToolCallId(`r2_${path}`),
        modelCallId: context.modelCallId,
        ordinal: index + 1,
        toolName: "test.read",
        rawArguments: { path },
      }));
      const twoStarted = new Promise<void>((resolve) => {
        entered.push(() => {}, resolve);
      });
      const result = runtime.executeBatch(requests, context);
      await twoStarted;
      expect(starts).toHaveLength(2);
      expect(peak).toBe(2);
      releases.get("B")!();
      await new Promise<void>((resolve) => entered.push(resolve));
      expect(starts).toHaveLength(3);
      expect(peak).toBe(2);
      releases.get("A")!();
      releases.get("C")!();
      expect((await result).map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
    });
  });
});
