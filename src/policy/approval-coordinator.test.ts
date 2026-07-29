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
import { ApprovalCoordinator } from "./approval-coordinator.js";

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
      rawArguments: { path: "hello.txt", content: "test", mode: "create" },
      executionTarget: "workspace",
      sandboxProfile: "host-workspace-v1",
      actionSummary: "Write file hello.txt",
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
});
