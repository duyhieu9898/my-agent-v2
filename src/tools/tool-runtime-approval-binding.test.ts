import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  createAgentId,
  createModelCallId,
  createRunId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import type { ApprovalRequestBinding } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type {
  NormalizedToolRequest,
  ToolDescriptor,
  ToolRegistration,
} from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import {
  createTempWorkspace,
  setupTestRuntime,
} from "./tool-runtime.test-support.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  describe("M3-R3A workspace policy containment", () => {
    it("binds normalized side-effect targetPath through approval and execution", async () => {
      const tempWorkspace = createTempWorkspace();
      const escapePath = path.join(
        path.dirname(tempWorkspace.workspaceRoot),
        "m3-r3ae-escape.txt",
      );
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime(
        tempWorkspace.workspaceRoot,
      );
      const events: string[] = [];
      let approvalRequests = 0;
      let capturedBinding: ApprovalRequestBinding | undefined;
      const rawArguments: Record<string, unknown> = {
        path: "sub/../safe.txt",
        content: "normalized target",
        mode: "create",
      };
      runtime.onEvent((event) => events.push(event.type));
      approvalCoordinator.onRequest((binding) => {
        approvalRequests++;
        capturedBinding = binding;
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });
      try {
        expect(
          fs.existsSync(path.join(tempWorkspace.workspaceRoot, "safe.txt")),
        ).toBe(false);
        expect(fs.existsSync(escapePath)).toBe(false);

        const execution = runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_normalized_approval"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "workspace.write_text",
              rawArguments,
            },
          ],
          batchContext,
        );
        rawArguments.path = "../m3-r3ae-escape.txt";
        rawArguments.content = "mutated";

        const outcomes = await execution;
        expect(approvalRequests).toBe(1);
        expect(capturedBinding).toMatchObject({
          toolName: "workspace.write_text",
          targetPath: "safe.txt",
          decision: "require-approval",
        });
        expect(capturedBinding?.targetPath).not.toBe("sub/../safe.txt");
        expect(
          events.filter((event) => event === "approval.requested"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event === "approval.resolved"),
        ).toHaveLength(1);
        expect(events.filter((event) => event === "tool.started")).toHaveLength(
          1,
        );
        expect(
          events.filter((event) => event === "tool.completed"),
        ).toHaveLength(1);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          ok: true,
          terminalState: "completed",
          normalizedArguments: {
            path: "sub/../safe.txt",
            content: "normalized target",
            mode: "create",
          },
          result: { path: "safe.txt" },
        });
        expect(
          fs.readFileSync(
            path.join(tempWorkspace.workspaceRoot, "safe.txt"),
            "utf8",
          ),
        ).toBe("normalized target");
        expect(fs.existsSync(escapePath)).toBe(false);
      } finally {
        tempWorkspace.cleanup();
      }
    });

    it("binds the normalized policy target as the workspace execution authority", async () => {
      const tempWorkspace = createTempWorkspace();
      fs.writeFileSync(
        path.join(tempWorkspace.workspaceRoot, "safe.txt"),
        "safe",
      );
      const { runtime, batchContext } = setupTestRuntime(
        tempWorkspace.workspaceRoot,
      );
      try {
        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_normalized_path"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "workspace.read_text",
              rawArguments: { path: "sub/../safe.txt" },
            },
          ],
          batchContext,
        );
        expect(outcome).toMatchObject({
          ok: true,
          normalizedArguments: { path: "sub/../safe.txt" },
          result: { path: "safe.txt", text: "safe" },
        });
      } finally {
        tempWorkspace.cleanup();
      }
    });
  });

  describe("Host ToolCallId vs Provider Call ID", () => {
    it("keeps providerCallId distinct from host toolCallId and preserves uniqueness on duplicate provider IDs", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const req1: NormalizedToolRequest = {
        toolCallId: createToolCallId("host_tcall_001"),
        providerCallId: "provider_call_dup",
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.list",
        rawArguments: { path: "src" },
      };

      const req2: NormalizedToolRequest = {
        toolCallId: createToolCallId("host_tcall_002"),
        providerCallId: "provider_call_dup",
        modelCallId: batchContext.modelCallId,
        ordinal: 2,
        toolName: "workspace.list",
        rawArguments: { path: "src" },
      };

      const outcomes = await runtime.executeBatch([req1, req2], batchContext);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]!.toolCallId).toBe("host_tcall_001");
      expect(outcomes[1]!.toolCallId).toBe("host_tcall_002");
      expect(outcomes[0]!.toolCallId).not.toBe(outcomes[1]!.toolCallId);
    });
  });

  describe("Deterministic Policy and Approval Binding Validation", () => {
    it("proves side-effecting tool executes after explicit single-use approval", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async (_args, context) => {
          context.markIoStarted();
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeSideEffectTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_side_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(true);
      expect(ioExecuted).toBe(true);

      expect(events).toEqual([
        "tool.requested",
        "policy.evaluated",
        "approval.requested",
        "approval.resolved",
        "tool.batch.planned",
        "tool.started",
        "tool.completed",
        "tool.batch.completed",
      ]);
    });

    it("prevents execution and tool.started when binding validation or wrong runId fails", async () => {
      const { approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeSideEffectTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      approvalCoordinator.onRequest((binding) => {
        const wrongRunId = createRunId("00000000-0000-4000-8000-000000000099");
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          wrongRunId,
          "allow-once",
        );
        approvalCoordinator.cancelPendingForRun(batchContext.runId);
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_side_2"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves runtime sandbox profile drift invalidates approval before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const origGetBinding =
        approvalCoordinator.getBindingByToolCallId.bind(approvalCoordinator);
      approvalCoordinator.getBindingByToolCallId = (tId) => {
        const b = origGetBinding(tId);
        return b
          ? { ...b, sandboxProfile: "drifted-sandbox-profile" }
          : undefined;
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_drift_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("prevents execution and tool.started when policy recheck fails or denies", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      let initialCheck = true;
      const policy: any = {
        evaluateInvocation: async () => {
          if (initialCheck) {
            initialCheck = false;
            return {
              decision: "require-approval",
              policyProfile: "profile-1",
              policyVersion: "1.0.0",
              reason: "requires approval",
            };
          }
          return {
            decision: "deny",
            policyProfile: "profile-1",
            policyVersion: "1.0.0",
            reason: "denied on recheck",
          };
        },
      };

      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_recheck_deny"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves workspace drift invalidates approval before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const origGetBinding =
        approvalCoordinator.getBindingByToolCallId.bind(approvalCoordinator);
      approvalCoordinator.getBindingByToolCallId = (tId) => {
        const b = origGetBinding(tId);
        return b
          ? { ...b, workspaceDigest: "drifted_workspace_digest" }
          : undefined;
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_ws_drift"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves recheck decision changing from require-approval to allow fails closed before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      let checkCount = 0;
      const policy: any = {
        evaluateInvocation: async () => {
          checkCount++;
          if (checkCount === 1) {
            return {
              decision: "require-approval",
              policyProfile: "profile-1",
              policyVersion: "1.0.0",
              reason: "requires approval",
            };
          }
          return {
            decision: "allow", // Changed to allow on recheck!
            policyProfile: "profile-1",
            policyVersion: "1.0.0",
            reason: "requires approval",
          };
        },
      };

      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_allow_recheck"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });
  });

  describe("Frozen R1C policy and authority closure", () => {
    function sideEffectRegistration(
      execute: ToolRegistration["execute"],
    ): ToolRegistration {
      return {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "approved action",
        redactionRules: [],
        inputLimits: { maxBytes: 100 },
        outputLimits: { maxBytes: 100 },
        progressFingerprintVersion: "1.0.0",
        execute,
      };
    }

    function validPolicy(decision: "allow" | "deny" | "require-approval") {
      return {
        decision,
        policyProfile: "test-policy",
        policyVersion: "1.0.0",
        reason: "test reason",
        ...(decision === "deny" ? {} : { targetPath: "original.txt" }),
        policyConstraints: { scope: "original" },
        redactionMetadata: { paths: "redacted" },
      };
    }

    it.each([
      [undefined, "missing policy result"],
      [
        { ...validPolicy("require-approval"), decision: "unsupported" },
        "unsupported decision",
      ],
      [
        { ...validPolicy("require-approval"), policyConstraints: undefined },
        "missing policy evidence",
      ],
      [validPolicy("allow"), "initial side-effect allow"],
      [validPolicy("deny"), "explicit deny"],
    ])(
      "fails closed for %s before approval, tool.started, or I/O",
      async (policyResult, _label) => {
        const idFactory = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let ioCount = 0;
        registry.register(
          sideEffectRegistration(async () => {
            ioCount++;
            return { done: true };
          }),
        );
        registry.freeze();
        let approvals = 0;
        const approvalsCoordinator = new ApprovalCoordinator(idFactory, 5000);
        approvalsCoordinator.onRequest(() => approvals++);
        const runtime = new ToolRuntime(
          registry,
          { evaluateInvocation: async () => policyResult } as any,
          approvalsCoordinator,
        );
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:test"),
          sessionId: idFactory.nextSessionId(),
          runId: idFactory.nextRunId(),
          attemptId: idFactory.nextAttemptId(),
          modelCallId: idFactory.nextModelCallId(),
          workspaceRoot: process.cwd(),
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("r1c_policy"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "test.side_effect",
              rawArguments: { path: "original.txt" },
            },
          ],
          context,
        );
        expect(outcome!.error?.code).toBe("TOOL_POLICY_DENIED");
        expect(approvals).toBe(0);
        expect(ioCount).toBe(0);
        expect(events).not.toContain("tool.started");
      },
    );

    it("uses admitted authority and exact approved/rechecked constraints after a deterministic policy barrier", async () => {
      const idFactory = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executorContext: any;
      registry.register(
        sideEffectRegistration(async (_args, context) => {
          executorContext = context;
          return { done: true };
        }),
      );
      registry.freeze();
      let releasePolicy!: () => void;
      const policyEntered = new Promise<void>((resolve) => {
        const release = resolve;
        releasePolicy = release;
      });
      let signalPolicyEntered!: () => void;
      const policyStarted = new Promise<void>((resolve) => {
        signalPolicyEntered = resolve;
      });
      let policyCalls = 0;
      const policy = {
        evaluateInvocation: async () => {
          policyCalls++;
          if (policyCalls === 1) {
            signalPolicyEntered();
            await policyEntered;
          }
          return validPolicy("require-approval");
        },
      };
      const approvals = new ApprovalCoordinator(idFactory, 5000);
      let approvedBinding: any;
      const runtime = new ToolRuntime(registry, policy as any, approvals);
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: "/original/workspace",
        sandboxProfile: "original-sandbox",
        totalRunToolCalls: 0,
      };
      const admitted = { ...context };
      approvals.onRequest((binding) => {
        approvedBinding = binding;
        approvals.resolveApproval(
          binding.approvalId,
          admitted.runId,
          "allow-once",
        );
      });
      const result = runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r1c_snapshot"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "test.side_effect",
            rawArguments: { path: "original.txt" },
          },
        ],
        context,
      );

      await policyStarted;
      Object.assign(context as any, {
        agentId: "mutated-agent",
        sessionKey: "mutated-session-key",
        sessionId: "mutated-session-id",
        runId: "mutated-run",
        attemptId: "mutated-attempt",
        modelCallId: "mutated-model-call",
        workspaceRoot: "/mutated/workspace",
        sandboxProfile: "mutated-sandbox",
        totalRunToolCalls: 999,
      });
      releasePolicy();
      const [outcome] = await result;

      expect(outcome!.ok).toBe(true);
      expect(approvedBinding).toMatchObject({
        agentId: admitted.agentId,
        sessionKey: admitted.sessionKey,
        sessionId: admitted.sessionId,
        runId: admitted.runId,
        attemptId: admitted.attemptId,
        modelCallId: admitted.modelCallId,
        sandboxProfile: "original-sandbox",
      });
      expect(executorContext).toMatchObject({
        agentId: admitted.agentId,
        workspaceRoot: "/original/workspace",
        sandboxProfile: "original-sandbox",
        targetPath: "original.txt",
        policyConstraints: { scope: "original" },
        inputLimits: { maxBytes: 100 },
        outputLimits: { maxBytes: 100 },
      });
      expect(
        JSON.stringify({ approvedBinding, executorContext }),
      ).not.toContain("mutated");
    });

    it("uses the original registry renderer and executor after replacement attempts", async () => {
      const idFactory = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let originalExecutorCalls = 0;
      let replacementExecutorCalls = 0;
      let originalRendererCalls = 0;
      let replacementRendererCalls = 0;
      registry.register({
        ...sideEffectRegistration(async () => {
          originalExecutorCalls++;
          return { done: true };
        }),
        approvalSummaryRenderer: () => {
          originalRendererCalls++;
          return "original approval summary";
        },
      });
      const originalExecuteOperation = registry.execute;
      const originalRenderOperation = registry.renderApprovalSummary;
      registry.freeze();

      expect(() => {
        (registry as any).execute = async () => {
          replacementExecutorCalls++;
          return { done: true };
        };
      }).toThrow();
      expect(() => {
        (registry as any).renderApprovalSummary = () => {
          replacementRendererCalls++;
          return "replacement approval summary";
        };
      }).toThrow();
      expect(registry.execute).toBe(originalExecuteOperation);
      expect(registry.renderApprovalSummary).toBe(originalRenderOperation);

      const approvals = new ApprovalCoordinator(idFactory, 5000);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async () => validPolicy("require-approval"),
        } as any,
        approvals,
      );
      let approvalSummary: string | undefined;
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      approvals.onRequest((binding) => {
        approvalSummary = binding.actionSummary;
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        );
      });

      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r1d_registry"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "test.side_effect",
            rawArguments: { path: "original.txt" },
          },
        ],
        context,
      );

      expect(outcome!.ok).toBe(true);
      expect(approvalSummary).toBe("original approval summary");
      expect(originalRendererCalls).toBe(1);
      expect(originalExecutorCalls).toBe(1);
      expect(replacementRendererCalls).toBe(0);
      expect(replacementExecutorCalls).toBe(0);
    });
  });

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

    it.each([
      ["decision", "allow"],
      ["policyProfile", "different-profile"],
      ["policyVersion", "different-version"],
      ["reason", "different-reason"],
      ["targetPath", "different-path"],
      ["policyConstraintsDigest", "different-digest"],
      ["redactionMetadataDigest", "different-digest"],
    ])(
      "fails closed when the approved binding %s is substituted",
      async (field, replacement) => {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let executions = 0;
        registry.register(
          r2Tool({
            name: "test.approved",
            effectClassification: "side-effecting",
            concurrencyTrait: "sequential",
            execute: async (args) => {
              executions++;
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
              reason: "approval required",
              policyConstraints: { scope: "r2" },
              redactionMetadata: { redact: "path" },
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
        const original = approvals.getBindingByToolCallId.bind(approvals);
        approvals.getBindingByToolCallId = (toolCallId) => {
          const binding = original(toolCallId);
          return binding ? { ...binding, [field]: replacement } : undefined;
        };
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));

        const outcomes = await runtime.executeBatch(
          [r2Request(context, 1, "test.approved", "approved.txt")],
          context,
        );

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ok).toBe(false);
        expect(outcomes[0]!.terminalState).toBe(
          "failed-before-known-side-effect",
        );
        expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
        expect(events).not.toContain("tool.started");
        expect(executions).toBe(0);
      },
    );
  });
});
