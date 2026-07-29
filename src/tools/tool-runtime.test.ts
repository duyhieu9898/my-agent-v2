import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  createAgentId,
  createAttemptId,
  createModelCallId,
  createRunId,
  createSessionId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type {
  NormalizedToolRequest,
  ToolDescriptor,
  ToolRegistration,
} from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import {
  workspaceListTool,
  workspaceReadTextTool,
  workspaceWriteTextTool,
} from "./workspace-tools.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  function createTempWorkspace() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-ws-"));
    return {
      workspaceRoot: tempDir,
      cleanup: () => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      },
    };
  }

  function setupTestRuntime(customWorkspaceRoot?: string) {
    const idFactory = createSequentialIdFactory();
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);
    registry.register(workspaceReadTextTool);
    registry.register(workspaceWriteTextTool);
    registry.freeze();

    const policy = new WorkspacePolicy();
    const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
    const runtime = new ToolRuntime(registry, policy, approvalCoordinator, {
      maxToolArgumentBytes: 1024,
    });

    const tempWs = createTempWorkspace();
    const workspaceRoot = customWorkspaceRoot ?? tempWs.workspaceRoot;

    const batchContext: ToolBatchContext = {
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId: idFactory.nextRunId(),
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      workspaceRoot,
      sandboxProfile: "host-workspace-v1",
      totalRunToolCalls: 0,
    };

    return {
      idFactory,
      registry,
      policy,
      approvalCoordinator,
      runtime,
      batchContext,
      cleanup: tempWs.cleanup,
    };
  }

  describe("Invocation Normalization & Argument Mutation Isolation", () => {
    it("prevents caller mutation of path, content, mode, and limit after admission from altering execution", async () => {
      const tempWs = createTempWorkspace();
      try {
        fs.writeFileSync(
          path.join(tempWs.workspaceRoot, "read.txt"),
          "hello world",
        );
        const { runtime, approvalCoordinator, batchContext } = setupTestRuntime(
          tempWs.workspaceRoot,
        );

        // Auto-approve using deterministic listener hook (no sleep)
        approvalCoordinator.onRequest((binding) => {
          approvalCoordinator.resolveApproval(
            binding.approvalId,
            batchContext.runId,
            "allow-once",
          );
        });

        const rawArguments: Record<string, unknown> = {
          path: "write.txt",
          content: "initial content",
          mode: "create",
        };

        const requests: NormalizedToolRequest[] = [
          {
            toolCallId: createToolCallId("tcall_1"),
            modelCallId: batchContext.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments,
          },
        ];

        const batchPromise = runtime.executeBatch(requests, batchContext);

        // Mutate rawArguments fields immediately after admission
        rawArguments["path"] = "../escape.txt";
        rawArguments["content"] = "HACKED";
        rawArguments["mode"] = "replace";

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ok).toBe(true);

        // Verify written file in temp workspace has original content
        const writtenPath = path.join(tempWs.workspaceRoot, "write.txt");
        expect(fs.existsSync(writtenPath)).toBe(true);
        expect(fs.readFileSync(writtenPath, "utf8")).toBe("initial content");

        // Verify outcome contains immutable normalized arguments
        expect(outcomes[0]!.normalizedArguments).toEqual({
          path: "write.txt",
          content: "initial content",
          mode: "create",
        });
      } finally {
        tempWs.cleanup();
      }
    });

    it("ensures successful and admitted failed outcomes retain normalized arguments", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_deny"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.read_text",
          rawArguments: { path: ".env" },
        },
      ];

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(outcomes[0]!.normalizedArguments).toEqual({ path: ".env" });
    });

    it("fails extra properties and malformed arguments before policy or execution", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_invalid"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments: { path: "src", extraProp: "unsupported" },
        },
      ];

      const events: string[] = [];
      runtime.onEvent((e) => events.push(e.type));

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_ARGUMENTS_INVALID");

      // Policy & execution events must not fire
      expect(events).not.toContain("policy.evaluated");
      expect(events).not.toContain("tool.started");
    });

    it("evaluates argument size against canonical normalized representation", async () => {
      const { idFactory, registry, policy, approvalCoordinator, batchContext } =
        setupTestRuntime();
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator, {
        maxToolArgumentBytes: 20,
      });

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_1"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments: { path: "very_long_path_name_exceeding_byte_limit" },
        },
      ];

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
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

  it("proves caller mutation after admission cannot alter normalized arguments", async () => {
    const { runtime, approvalCoordinator, batchContext, cleanup } =
      setupTestRuntime();

    try {
      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const mutableArgs = {
        path: "mutable.txt",
        content: "original",
        mode: "create" as const,
      };

      const rawReq: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_2"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.write_text",
        rawArguments: mutableArgs,
      };

      const executePromise = runtime.executeBatch([rawReq], batchContext);

      // Mutate raw input object immediately after admission
      mutableArgs.content = "HACKED_CONTENT";

      const outcomes = await executePromise;
      const outcome = outcomes[0]!;
      expect(outcome.ok).toBe(true);
      expect(outcome.normalizedArguments).toEqual({
        path: "mutable.txt",
        content: "original",
        mode: "create",
      });
    } finally {
      cleanup();
    }
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
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeSideEffectTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy();
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

      const policy = new WorkspacePolicy();
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

      const policy = new WorkspacePolicy();
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

      const policy = new WorkspacePolicy();
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
