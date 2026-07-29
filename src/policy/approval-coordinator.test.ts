import { describe, expect, it } from "vitest";
import {
  createAgentId,
  createAttemptId,
  createModelCallId,
  createRunId,
  createSessionId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import {
  ApprovalCoordinator,
  type ApprovalRequestBinding,
} from "./approval-coordinator.js";

describe("ApprovalCoordinator", () => {
  it("handles requestApproval, notification listener, and allow-once resolution", async () => {
    const idFactory = createSequentialIdFactory();
    const coordinator = new ApprovalCoordinator(idFactory, 5000);

    const runId = idFactory.nextRunId();
    let notifiedApprovalId: string | undefined;

    coordinator.onRequest((binding) => {
      notifiedApprovalId = binding.approvalId;
    });

    const approvalPromise = coordinator.requestApproval({
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId,
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      toolCallId: idFactory.nextToolCallId(),
      toolName: "workspace.write_text",
      normalizedArguments: {
        path: "hello.txt",
        content: "test",
        mode: "create",
      },
      workspaceRoot: process.cwd(),
      executionTarget: "workspace",
      sandboxProfile: "host-workspace-v1",
      sandboxRequirement: "host-workspace-v1",
      actionSummary: "Write file hello.txt",
      decision: "require-approval",
      policyProfile: "workspace-policy-v1",
      reason: "write requires approval",
    });

    expect(notifiedApprovalId).toBeDefined();

    const resolveRes = coordinator.resolveApproval(
      notifiedApprovalId as any,
      runId,
      "allow-once",
    );
    expect(resolveRes.status).toBe("allowed");

    const status = await approvalPromise;
    expect(status).toBe("allowed");

    // Second resolution should return already-resolved (single-use)
    const secondRes = coordinator.resolveApproval(
      notifiedApprovalId as any,
      runId,
      "allow-once",
    );
    expect(secondRes.status).toBe("already-resolved");
  });

  it("prevents listener or accessor mutation from altering stored binding authority", async () => {
    const idFactory = createSequentialIdFactory();
    const coordinator = new ApprovalCoordinator(idFactory, 5000);
    const runId = idFactory.nextRunId();

    let capturedBinding: ApprovalRequestBinding | undefined;
    coordinator.onRequest((binding) => {
      capturedBinding = binding;
      expect(Object.isFrozen(binding)).toBe(true);
      expect(() => {
        (binding as any).actionSummary = "hacked summary";
      }).toThrow();
    });

    const approvalPromise = coordinator.requestApproval({
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId,
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      toolCallId: idFactory.nextToolCallId(),
      toolName: "workspace.write_text",
      normalizedArguments: {
        path: "hello.txt",
        content: "test",
        mode: "create",
      },
      workspaceRoot: process.cwd(),
      executionTarget: "workspace",
      sandboxProfile: "host-workspace-v1",
      sandboxRequirement: "host-workspace-v1",
      actionSummary: "Write file hello.txt",
      decision: "require-approval",
      policyProfile: "workspace-policy-v1",
      reason: "write requires approval",
    });

    expect(capturedBinding).toBeDefined();
    const fetched = coordinator.getBinding(capturedBinding!.approvalId)!;
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(fetched.actionSummary).toBe("Write file hello.txt");

    coordinator.resolveApproval(
      capturedBinding!.approvalId,
      runId,
      "allow-once",
    );
    await approvalPromise;
  });

  it("fails resolution when wrong runId is supplied", async () => {
    const idFactory = createSequentialIdFactory();
    const coordinator = new ApprovalCoordinator(idFactory, 5000);
    const runId = idFactory.nextRunId();
    const wrongRunId = createRunId("00000000-0000-4000-8000-000000000099");

    let approvalId: string | undefined;
    coordinator.onRequest((b) => {
      approvalId = b.approvalId;
    });

    const approvalPromise = coordinator.requestApproval({
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId,
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      toolCallId: idFactory.nextToolCallId(),
      toolName: "workspace.write_text",
      normalizedArguments: { path: "hello.txt" },
      workspaceRoot: process.cwd(),
      executionTarget: "workspace",
      sandboxProfile: "host-workspace-v1",
      sandboxRequirement: "host-workspace-v1",
      actionSummary: "Write file",
      decision: "require-approval",
      policyProfile: "workspace-policy-v1",
      reason: "write requires approval",
    });

    const wrongRes = coordinator.resolveApproval(
      approvalId as any,
      wrongRunId,
      "allow-once",
    );
    expect(wrongRes.status).toBe("not-found");

    coordinator.cancelPendingForRun(runId);
    const status = await approvalPromise;
    expect(status).toBe("cancelled");
  });
});
