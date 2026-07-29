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
import type { NormalizedToolRequest, ToolDescriptor } from "./contracts.js";
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

    const batchContext: ToolBatchContext = {
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId: idFactory.nextRunId(),
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      workspaceRoot: customWorkspaceRoot ?? process.cwd(),
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

  describe("Approval Binding & Policy Recheck", () => {
    it("executes side-effect tool when allow-once is granted for exact bound invocation using deterministic barrier", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolDescriptor = {
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

      // Deterministic coordinator listener hook (no sleep)
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
        "tool.batch.planned",
        "tool.requested",
        "policy.evaluated",
        "approval.requested",
        "approval.resolved",
        "tool.started",
        "tool.completed",
        "tool.batch.completed",
      ]);
    });

    it("prevents execution and tool.started when binding validation or wrong runId fails", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolDescriptor = {
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

      // Deterministic coordinator listener hook that cancels run
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

    it("prevents execution and tool.started when policy recheck fails or denies", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      const fakeTool: ToolDescriptor = {
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
        execute: async () => ({ done: true }),
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
          // Recheck returns deny!
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
      expect(events).not.toContain("tool.started");
    });
  });
});
