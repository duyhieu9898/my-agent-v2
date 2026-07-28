import { createHash } from "node:crypto";
import { AppError } from "../core/errors.js";
import type {
  AgentId,
  ApprovalId,
  AttemptId,
  IdFactory,
  ModelCallId,
  RunId,
  SessionId,
  SessionKey,
  ToolCallId,
} from "../core/identities.js";

export interface ApprovalRequestBinding {
  approvalId: ApprovalId;
  agentId: AgentId;
  sessionKey: SessionKey;
  sessionId: SessionId;
  runId: RunId;
  attemptId: AttemptId;
  modelCallId: ModelCallId;
  toolCallId: ToolCallId;
  toolName: string;
  normalizedArgumentDigest: string;
  executionTarget: string;
  sandboxProfile: string;
  actionSummary: string;
  createdAt: number;
  expiresAt: number;
  policyProfile: string;
  reason: string;
}

export type ApprovalDecision = "allow-once" | "deny";

export type ApprovalResolutionStatus =
  | "allowed"
  | "denied"
  | "already-resolved"
  | "expired"
  | "cancelled"
  | "not-found";

export interface ApprovalResolutionResult {
  approvalId: ApprovalId;
  status: ApprovalResolutionStatus;
}

interface PendingApproval {
  binding: ApprovalRequestBinding;
  resolve: (status: ApprovalResolutionStatus) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalRequestedListener = (
  binding: ApprovalRequestBinding,
) => void;

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalRequestedListener>();

  public constructor(
    private readonly idFactory: IdFactory,
    private readonly defaultTimeoutMs = 30000,
  ) {}

  public onRequest(listener: ApprovalRequestedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public computeDigest(args: Record<string, unknown>): string {
    const canonical = JSON.stringify(args, Object.keys(args).sort());
    return createHash("sha256").update(canonical).digest("hex");
  }

  public async requestApproval(params: {
    agentId: AgentId;
    sessionKey: SessionKey;
    sessionId: SessionId;
    runId: RunId;
    attemptId: AttemptId;
    modelCallId: ModelCallId;
    toolCallId: ToolCallId;
    toolName: string;
    rawArguments: Record<string, unknown>;
    executionTarget: string;
    sandboxProfile: string;
    actionSummary: string;
    policyProfile: string;
    reason: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ApprovalResolutionStatus> {
    const approvalId = this.idFactory.nextApprovalId();
    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = now + timeoutMs;
    const digest = this.computeDigest(params.rawArguments);

    const binding: ApprovalRequestBinding = {
      approvalId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      attemptId: params.attemptId,
      modelCallId: params.modelCallId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      normalizedArgumentDigest: digest,
      executionTarget: params.executionTarget,
      sandboxProfile: params.sandboxProfile,
      actionSummary: params.actionSummary,
      createdAt: now,
      expiresAt,
      policyProfile: params.policyProfile,
      reason: params.reason,
    };

    return new Promise<ApprovalResolutionStatus>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(approvalId, "expired");
      }, timeoutMs);

      const pendingItem: PendingApproval = {
        binding,
        resolve,
        timer,
      };

      this.pending.set(approvalId, pendingItem);

      if (params.signal) {
        if (params.signal.aborted) {
          this.finish(approvalId, "cancelled");
          return;
        }
        params.signal.addEventListener("abort", () => {
          this.finish(approvalId, "cancelled");
        });
      }

      // Notify listeners (Gateway / Event emitter)
      for (const listener of this.listeners) {
        try {
          listener(binding);
        } catch {
          // Listeners must not throw
        }
      }
    });
  }

  public resolveApproval(
    approvalId: ApprovalId,
    runId: RunId,
    decision: ApprovalDecision,
  ): ApprovalResolutionResult {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return { approvalId, status: "not-found" };
    }

    if (pending.binding.runId !== runId) {
      return { approvalId, status: "not-found" };
    }

    const status: ApprovalResolutionStatus =
      decision === "allow-once" ? "allowed" : "denied";

    this.finish(approvalId, status);
    return { approvalId, status };
  }

  public cancelPendingForRun(runId: RunId, reason?: string): void {
    for (const [approvalId, pending] of this.pending.entries()) {
      if (pending.binding.runId === runId) {
        this.finish(approvalId as ApprovalId, "cancelled");
      }
    }
  }

  public dispose(): void {
    for (const [approvalId] of this.pending.keys()) {
      this.finish(approvalId as ApprovalId, "cancelled");
    }
    this.listeners.clear();
  }

  private finish(approvalId: string, status: ApprovalResolutionStatus): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    pending.resolve(status);
  }
}
