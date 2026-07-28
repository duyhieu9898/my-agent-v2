import { createApprovalId, createRunId } from "../../core/identities.js";
import type { GatewayMethodHandler } from "./types.js";

export const handleApprovalResolve: GatewayMethodHandler = async (context) => {
  const { approvalCoordinator } = context.dependencies;
  if (!approvalCoordinator) {
    return {
      type: "res",
      id: context.request.id,
      ok: false,
      error: {
        code: "GATEWAY_PROTOCOL_ERROR",
        message: "Approval coordinator unavailable",
      },
    };
  }

  const params = context.request.params as {
    approvalId: string;
    runId: string;
    decision: "allow-once" | "deny";
  };

  const result = approvalCoordinator.resolveApproval(
    createApprovalId(params.approvalId),
    createRunId(params.runId),
    params.decision,
  );

  return {
    type: "res",
    id: context.request.id,
    ok: true,
    payload: result,
  };
};
