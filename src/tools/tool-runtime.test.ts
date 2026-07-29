import { describe, expect, it, vi } from "vitest";
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
  function setupTestRuntime() {
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
      workspaceRoot: process.cwd(),
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

  describe("Invocation Normalization", () => {
    it("prevents caller argument mutation after executeBatch admission from altering execution", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const rawArguments: Record<string, unknown> = { path: "src" };
      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_1"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments,
        },
      ];

      const batchPromise = runtime.executeBatch(requests, batchContext);

      // Mutate rawArguments immediately after admission
      rawArguments["path"] = "../invalid_escape";

      const outcomes = await batchPromise;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ok).toBe(true);
      expect((outcomes[0]!.result as any).path).toBe("src");
    });

    it("fails extra properties and malformed arguments before policy or execution", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_1"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments: { path: "src", unknownExtraField: true },
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
        maxToolArgumentBytes: 20, // Very small limit
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
    it("executes side-effect tool when allow-once is granted for exact bound invocation", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let requestedApprovalId: string | undefined;
      approvalCoordinator.onRequest((binding) => {
        requestedApprovalId = binding.approvalId;
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_write_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.write_text",
        rawArguments: {
          path: "package.json",
          content: '{"name":"test"}',
          mode: "replace",
        },
      };

      const events: string[] = [];
      runtime.onEvent((e) => events.push(e.type));

      const batchPromise = runtime.executeBatch([req], batchContext);

      // Wait brief moment for approval request
      await new Promise((r) => setTimeout(r, 10));
      expect(requestedApprovalId).toBeDefined();

      const resolveRes = approvalCoordinator.resolveApproval(
        requestedApprovalId as any,
        batchContext.runId,
        "allow-once",
      );
      expect(resolveRes.status).toBe("allowed");

      const outcomes = await batchPromise;
      expect(outcomes[0]!.ok).toBe(true);

      // Verify lifecycle sequence
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

    it("prevents execution and tool.started when wrong runId attempts to resolve approval", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let requestedApprovalId: string | undefined;
      approvalCoordinator.onRequest((binding) => {
        requestedApprovalId = binding.approvalId;
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_write_2"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.write_text",
        rawArguments: {
          path: "package.json",
          content: '{"name":"test"}',
          mode: "replace",
        },
      };

      const events: string[] = [];
      runtime.onEvent((e) => events.push(e.type));

      const batchPromise = runtime.executeBatch([req], batchContext);
      await new Promise((r) => setTimeout(r, 10));

      const wrongRunId = createRunId("00000000-0000-4000-8000-000000000000");
      const resolveRes = approvalCoordinator.resolveApproval(
        requestedApprovalId as any,
        wrongRunId,
        "allow-once",
      );
      expect(resolveRes.status).toBe("not-found");

      // Now cancel the pending approval for the actual run
      approvalCoordinator.cancelPendingForRun(batchContext.runId);

      const outcomes = await batchPromise;
      expect(outcomes[0]!.ok).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("fails closed when policy explicitly denies invocation without requesting approval", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let approvalRequested = false;
      approvalCoordinator.onRequest(() => {
        approvalRequested = true;
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_deny_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.read_text",
        rawArguments: { path: ".env" }, // Protected file
      };

      const outcomes = await runtime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(approvalRequested).toBe(false);
    });
  });
});
