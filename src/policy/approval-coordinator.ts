import { createHash } from "node:crypto";
import * as path from "node:path";
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

import { canonicalJsonStringify, deepFreeze } from "../tools/contracts.js";

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
  workspaceDigest: string;
  executionTarget: string;
  sandboxProfile: string;
  actionSummary: string;
  createdAt: number;
  expiresAt: number;
  policyProfile: string;
  policyVersion: string;
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
  private readonly bindings = new Map<string, ApprovalRequestBinding>();
  private readonly resolvedIds = new Set<string>();
  private readonly listeners = new Set<ApprovalRequestedListener>();

  public constructor(
    private readonly idFactory: IdFactory,
    private readonly defaultTimeoutMs = 30000,
  ) {}

  public onRequest(listener: ApprovalRequestedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public computeDigest(args?: Record<string, unknown>): string {
    const safeArgs = args ?? {};
    const canonical = canonicalJsonStringify(safeArgs);
    return createHash("sha256").update(canonical).digest("hex");
  }

  public computeWorkspaceDigest(workspaceRoot?: string): string {
    const canonical = path.resolve(workspaceRoot ?? process.cwd());
    return createHash("sha256").update(canonical).digest("hex");
  }

  public getBinding(
    approvalId: ApprovalId,
  ): ApprovalRequestBinding | undefined {
    return this.bindings.get(approvalId);
  }

  public getBindingByToolCallId(
    toolCallId: ToolCallId,
  ): ApprovalRequestBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.toolCallId === toolCallId) return binding;
    }
    return undefined;
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
    normalizedArguments?: Record<string, unknown>;
    rawArguments?: Record<string, unknown>;
    workspaceRoot?: string;
    executionTarget: string;
    sandboxProfile: string;
    actionSummary: string;
    policyProfile: string;
    policyVersion?: string;
    reason: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ApprovalResolutionStatus> {
    const approvalId = this.idFactory.nextApprovalId();
    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = now + timeoutMs;
    const normalizedArgs =
      params.normalizedArguments ?? params.rawArguments ?? {};
    const digest = this.computeDigest(normalizedArgs);
    const workspaceDigest = this.computeWorkspaceDigest(params.workspaceRoot);

    const binding: ApprovalRequestBinding = deepFreeze({
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
      workspaceDigest,
      executionTarget: params.executionTarget,
      sandboxProfile: params.sandboxProfile,
      actionSummary: params.actionSummary,
      createdAt: now,
      expiresAt,
      policyProfile: params.policyProfile,
      policyVersion: params.policyVersion ?? "1.0.0",
      reason: params.reason,
    });

    this.bindings.set(approvalId, binding);

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
    if (this.resolvedIds.has(approvalId)) {
      return { approvalId, status: "already-resolved" };
    }

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

  public cancelPendingForRun(runId: RunId, _reason?: string): void {
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

    this.resolvedIds.add(approvalId);
    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    pending.resolve(status);
  }
}
