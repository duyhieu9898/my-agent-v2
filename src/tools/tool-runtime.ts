import { AppError } from "../core/errors.js";
import type {
  AgentId,
  AttemptId,
  IdFactory,
  ModelCallId,
  RunId,
  SessionId,
  SessionKey,
  ToolCallId,
} from "../core/identities.js";

import type {
  ApprovalCoordinator,
  ApprovalRequestBinding,
} from "../policy/approval-coordinator.js";
import type {
  InvocationPolicyResult,
  PolicyDecisionType,
  WorkspacePolicy,
} from "../policy/workspace-policy.js";
import {
  canonicalJsonStringify,
  deepFreeze,
  strictJsonSnapshot,
  type NormalizedToolOutcome,
  type NormalizedToolRequest,
  type TerminalToolState,
  type ToolDescriptor,
  type ToolExecutionContext,
} from "./contracts.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface ToolRuntimeConfig {
  maxConcurrentToolCalls?: number;
  maxToolCallsPerBatch?: number;
  maxToolCallsPerRun?: number;
  maxToolIterations?: number;
  toolTimeoutMs?: number;
  approvalTimeoutMs?: number;
  maxToolArgumentBytes?: number;
  maxToolResultBytes?: number;
}

export interface ToolBatchContext {
  agentId: AgentId;
  sessionKey: SessionKey;
  sessionId: SessionId;
  runId: RunId;
  attemptId: AttemptId;
  modelCallId: ModelCallId;
  workspaceRoot: string;
  sandboxProfile: string;
  totalRunToolCalls: number;
}

export type ToolEventListener = (event: {
  type: string;
  runId: RunId;
  toolCallId?: ToolCallId;
  approvalId?: string;
  parentOperationId?: string;
  data?: Record<string, unknown>;
}) => void;

type InvocationPolicySnapshot = Readonly<{
  decision: PolicyDecisionType;
  reason: string;
  policyProfile: string;
  policyVersion: string;
  targetPath?: string;
  policyConstraints: Record<string, unknown>;
  redactionMetadata: Record<string, unknown>;
}>;

type BatchPlanItem = {
  req: NormalizedToolRequest;
  tool?: ToolDescriptor;
  normalizedArguments?: Record<string, unknown>;
  admissionError?: AppError;
  policy?: InvocationPolicySnapshot | undefined;
  executionContext?: ToolExecutionContext;
  approvalGated?: boolean;
};

function snapshotInvocationPolicy(
  result: unknown,
): InvocationPolicySnapshot | undefined {
  if (!result || typeof result !== "object") return undefined;
  const candidate = result as Partial<InvocationPolicyResult>;
  if (
    !["allow", "deny", "require-approval"].includes(candidate.decision ?? "") ||
    typeof candidate.reason !== "string" ||
    candidate.reason.length === 0 ||
    typeof candidate.policyProfile !== "string" ||
    candidate.policyProfile.length === 0 ||
    typeof candidate.policyVersion !== "string" ||
    candidate.policyVersion.length === 0 ||
    !candidate.policyConstraints ||
    typeof candidate.policyConstraints !== "object" ||
    Array.isArray(candidate.policyConstraints) ||
    !candidate.redactionMetadata ||
    typeof candidate.redactionMetadata !== "object" ||
    Array.isArray(candidate.redactionMetadata) ||
    (candidate.targetPath !== undefined &&
      typeof candidate.targetPath !== "string") ||
    (candidate.decision !== "deny" &&
      (typeof candidate.targetPath !== "string" ||
        candidate.targetPath.length === 0))
  ) {
    return undefined;
  }

  try {
    return deepFreeze({
      decision: candidate.decision as PolicyDecisionType,
      reason: candidate.reason,
      policyProfile: candidate.policyProfile,
      policyVersion: candidate.policyVersion,
      ...(candidate.targetPath !== undefined
        ? { targetPath: candidate.targetPath }
        : {}),
      policyConstraints: strictJsonSnapshot(candidate.policyConstraints),
      redactionMetadata: strictJsonSnapshot(candidate.redactionMetadata),
    });
  } catch {
    return undefined;
  }
}

function approvalBindingMatches({
  binding,
  batchContext,
  request,
  tool,
  normalizedArguments,
  policy,
  workspaceRoot,
  approvalCoordinator,
}: {
  binding: ApprovalRequestBinding | undefined;
  batchContext: Readonly<ToolBatchContext>;
  request: NormalizedToolRequest;
  tool: ToolDescriptor;
  normalizedArguments: Record<string, unknown>;
  policy: InvocationPolicySnapshot;
  workspaceRoot: string;
  approvalCoordinator: ApprovalCoordinator;
}): boolean {
  return (
    binding !== undefined &&
    binding.agentId === batchContext.agentId &&
    binding.sessionKey === batchContext.sessionKey &&
    binding.sessionId === batchContext.sessionId &&
    binding.runId === batchContext.runId &&
    binding.attemptId === batchContext.attemptId &&
    binding.modelCallId === batchContext.modelCallId &&
    binding.toolCallId === request.toolCallId &&
    binding.toolName === request.toolName &&
    binding.normalizedArgumentDigest ===
      approvalCoordinator.computeDigest(normalizedArguments) &&
    binding.workspaceDigest ===
      approvalCoordinator.computeWorkspaceDigest(workspaceRoot) &&
    binding.executionTarget === tool.executionTarget &&
    binding.sandboxProfile === batchContext.sandboxProfile &&
    binding.sandboxRequirement === tool.sandboxRequirement &&
    binding.decision === policy.decision &&
    binding.policyProfile === policy.policyProfile &&
    binding.policyVersion === policy.policyVersion &&
    binding.reason === policy.reason &&
    binding.targetPath === policy.targetPath &&
    binding.policyConstraintsDigest ===
      approvalCoordinator.computeCanonicalDigest(policy.policyConstraints) &&
    binding.redactionMetadataDigest ===
      approvalCoordinator.computeCanonicalDigest(policy.redactionMetadata)
  );
}

export class ToolRuntime {
  private readonly limits: Required<ToolRuntimeConfig>;
  private readonly eventListeners = new Set<ToolEventListener>();

  public constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: WorkspacePolicy,
    private readonly approvalCoordinator: ApprovalCoordinator,
    config?: ToolRuntimeConfig,
  ) {
    this.limits = {
      maxConcurrentToolCalls: config?.maxConcurrentToolCalls ?? 4,
      maxToolCallsPerBatch: config?.maxToolCallsPerBatch ?? 8,
      maxToolCallsPerRun: config?.maxToolCallsPerRun ?? 16,
      maxToolIterations: config?.maxToolIterations ?? 8,
      toolTimeoutMs: config?.toolTimeoutMs ?? 30000,
      approvalTimeoutMs: config?.approvalTimeoutMs ?? 30000,
      maxToolArgumentBytes: config?.maxToolArgumentBytes ?? 65536,
      maxToolResultBytes: config?.maxToolResultBytes ?? 65536,
    };

    this.approvalCoordinator.onRequest((binding) => {
      this.emitEvent("approval.requested", binding.runId, {
        toolCallId: binding.toolCallId,
        approvalId: binding.approvalId,
        data: {
          approvalId: binding.approvalId,
          summary: binding.actionSummary,
        },
      });
    });
  }

  public onEvent(listener: ToolEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emitEvent(
    type: string,
    runId: RunId,
    details?: {
      toolCallId?: ToolCallId;
      approvalId?: string;
      parentOperationId?: string;
      data?: Record<string, unknown>;
    },
  ): void {
    for (const listener of this.eventListeners) {
      try {
        listener({
          type,
          runId,
          ...(details?.toolCallId ? { toolCallId: details.toolCallId } : {}),
          ...(details?.approvalId ? { approvalId: details.approvalId } : {}),
          ...(details?.parentOperationId
            ? { parentOperationId: details.parentOperationId }
            : {}),
          ...(details?.data ? { data: details.data } : {}),
        });
      } catch {
        // ignore listener errors
      }
    }
  }

  public async executeBatch(
    requests: NormalizedToolRequest[],
    batchContext: ToolBatchContext,
    signal?: AbortSignal,
  ): Promise<NormalizedToolOutcome[]> {
    // Admission owns the authority used after the first await. Do not retain a
    // caller-owned batch context across policy, approval, or execution.
    const admittedBatchContext = deepFreeze({ ...batchContext });
    const { runId, workspaceRoot } = admittedBatchContext;

    if (requests.length > this.limits.maxToolCallsPerBatch) {
      throw new AppError(
        "TOOL_BUDGET_EXHAUSTED",
        `Batch size ${requests.length} exceeds maximum allowed tool calls per batch (${this.limits.maxToolCallsPerBatch})`,
      );
    }

    if (
      admittedBatchContext.totalRunToolCalls + requests.length >
      this.limits.maxToolCallsPerRun
    ) {
      throw new AppError(
        "TOOL_BUDGET_EXHAUSTED",
        `Run tool calls ${admittedBatchContext.totalRunToolCalls + requests.length} exceeds maximum per run (${this.limits.maxToolCallsPerRun})`,
      );
    }

    const plannedItems: BatchPlanItem[] = [];

    for (const req of requests) {
      this.emitEvent("tool.requested", runId, {
        toolCallId: req.toolCallId,
        data: { toolName: req.toolName, ordinal: req.ordinal },
      });

      const tool = this.registry.get(req.toolName);
      if (!tool) {
        plannedItems.push({
          req,
          admissionError: new AppError(
            "TOOL_NOT_FOUND",
            `Tool '${req.toolName}' is not registered`,
          ),
        });
        continue;
      }

      const argVal = this.registry.validateArguments(
        req.toolName,
        req.rawArguments,
      );
      if (!argVal.ok) {
        plannedItems.push({
          req,
          tool,
          admissionError: new AppError(
            "TOOL_ARGUMENTS_INVALID",
            `Invalid arguments for tool '${req.toolName}': ${argVal.error}`,
          ),
        });
        continue;
      }

      const normalizedArguments = strictJsonSnapshot(argVal.value);

      const argBytes = Buffer.byteLength(
        canonicalJsonStringify(normalizedArguments),
        "utf8",
      );
      if (argBytes > this.limits.maxToolArgumentBytes) {
        plannedItems.push({
          req,
          tool,
          normalizedArguments,
          admissionError: new AppError(
            "TOOL_ARGUMENTS_INVALID",
            `Tool arguments size ${argBytes} bytes exceeds limit ${this.limits.maxToolArgumentBytes}`,
          ),
        });
        continue;
      }

      plannedItems.push({ req, tool, normalizedArguments });
    }

    for (const item of plannedItems) {
      if (item.admissionError || !item.tool || !item.normalizedArguments) {
        continue;
      }
      try {
        item.policy = snapshotInvocationPolicy(
          await this.policy.evaluateInvocation(
            item.tool,
            item.normalizedArguments,
            workspaceRoot,
          ),
        );
      } catch {
        item.policy = undefined;
      }
      if (!item.policy) {
        item.admissionError = new AppError(
          "TOOL_POLICY_DENIED",
          `Policy returned invalid authority for tool '${item.req.toolName}'`,
        );
        continue;
      }
      this.emitEvent("policy.evaluated", runId, {
        toolCallId: item.req.toolCallId,
        data: { decision: item.policy.decision, reason: item.policy.reason },
      });
      if (item.policy.decision === "deny") {
        item.admissionError = new AppError(
          "TOOL_POLICY_DENIED",
          `Policy denied tool '${item.req.toolName}': ${item.policy.reason}`,
        );
      } else if (
        item.tool.effectClassification === "side-effecting" &&
        item.policy.decision !== "require-approval"
      ) {
        item.admissionError = new AppError(
          "TOOL_POLICY_DENIED",
          `Side-effecting tool '${item.req.toolName}' requires explicit approval authority`,
        );
      } else if (item.policy.decision === "require-approval") {
        item.approvalGated = true;
        let actionSummary: string;
        try {
          actionSummary = this.registry.renderApprovalSummary(
            item.req.toolName,
            item.normalizedArguments,
          );
        } catch {
          item.admissionError = new AppError(
            "TOOL_IMPLEMENTATION_FAILED",
            `Failed to render approval summary for '${item.req.toolName}'`,
          );
          continue;
        }
        const approvalStatus = await this.approvalCoordinator.requestApproval({
          agentId: admittedBatchContext.agentId,
          sessionKey: admittedBatchContext.sessionKey,
          sessionId: admittedBatchContext.sessionId,
          runId: admittedBatchContext.runId,
          attemptId: admittedBatchContext.attemptId,
          modelCallId: admittedBatchContext.modelCallId,
          toolCallId: item.req.toolCallId,
          toolName: item.req.toolName,
          normalizedArguments: item.normalizedArguments,
          workspaceRoot,
          executionTarget: item.tool.executionTarget,
          sandboxProfile: admittedBatchContext.sandboxProfile,
          sandboxRequirement: item.tool.sandboxRequirement,
          actionSummary,
          decision: item.policy.decision,
          policyProfile: item.policy.policyProfile,
          policyVersion: item.policy.policyVersion,
          reason: item.policy.reason,
          ...(item.policy.targetPath !== undefined
            ? { targetPath: item.policy.targetPath }
            : {}),
          policyConstraints: item.policy.policyConstraints,
          redactionMetadata: item.policy.redactionMetadata,
          timeoutMs: this.limits.approvalTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        const binding = this.approvalCoordinator.getBindingByToolCallId(
          item.req.toolCallId,
        );
        this.emitEvent("approval.resolved", runId, {
          toolCallId: item.req.toolCallId,
          ...(binding ? { approvalId: binding.approvalId } : {}),
          data: { status: approvalStatus },
        });
        if (approvalStatus !== "allowed") {
          item.admissionError = new AppError(
            approvalStatus === "expired"
              ? "TOOL_APPROVAL_EXPIRED"
              : approvalStatus === "cancelled"
                ? "TOOL_CANCELLED"
                : "TOOL_APPROVAL_DENIED",
            `Approval for tool '${item.req.toolName}' was ${approvalStatus}`,
          );
        } else {
          if (
            !approvalBindingMatches({
              binding,
              batchContext: admittedBatchContext,
              request: item.req,
              tool: item.tool,
              normalizedArguments: item.normalizedArguments,
              policy: item.policy,
              workspaceRoot,
              approvalCoordinator: this.approvalCoordinator,
            })
          ) {
            item.admissionError = new AppError(
              "TOOL_APPROVAL_DENIED",
              `Approval binding validation failed for tool '${item.req.toolName}'`,
            );
            continue;
          }
          let rechecked: InvocationPolicySnapshot | undefined;
          try {
            rechecked = snapshotInvocationPolicy(
              await this.policy.evaluateInvocation(
                item.tool,
                item.normalizedArguments,
                workspaceRoot,
              ),
            );
          } catch {
            rechecked = undefined;
          }
          if (
            !rechecked ||
            rechecked.decision !== "require-approval" ||
            rechecked.policyProfile !== item.policy.policyProfile ||
            rechecked.policyVersion !== item.policy.policyVersion ||
            rechecked.reason !== item.policy.reason ||
            rechecked.targetPath !== item.policy.targetPath ||
            this.approvalCoordinator.computeCanonicalDigest(
              rechecked.policyConstraints,
            ) !==
              this.approvalCoordinator.computeCanonicalDigest(
                item.policy.policyConstraints,
              ) ||
            this.approvalCoordinator.computeCanonicalDigest(
              rechecked.redactionMetadata,
            ) !==
              this.approvalCoordinator.computeCanonicalDigest(
                item.policy.redactionMetadata,
              )
          ) {
            item.admissionError = new AppError(
              "TOOL_POLICY_DENIED",
              `Policy recheck failed for tool '${item.req.toolName}': decision changed or bound field mismatched`,
            );
          } else {
            item.policy = rechecked;
          }
        }
      }
      if (!item.admissionError) {
        item.executionContext = deepFreeze({
          agentId: admittedBatchContext.agentId,
          workspaceRoot,
          targetPath: item.policy.targetPath ?? "",
          toolCallId: item.req.toolCallId,
          deadline:
            Date.now() +
            Math.min(item.tool.timeoutMs, this.limits.toolTimeoutMs),
          inputLimits: item.tool.inputLimits,
          outputLimits: item.tool.outputLimits,
          policyConstraints: item.policy.policyConstraints,
          sandboxProfile: admittedBatchContext.sandboxProfile,
          markIoStarted: () => {},
          markSideEffectPossible: () => {},
        });
      }
    }

    const allParallelSafeRead = plannedItems.every(
      (item) =>
        !item.admissionError &&
        item.tool?.effectClassification === "read-only" &&
        item.tool?.concurrencyTrait === "parallel-safe" &&
        item.policy?.decision === "allow",
    );

    const isSequential = !allParallelSafeRead;

    this.emitEvent("tool.batch.planned", runId, {
      data: {
        count: requests.length,
        schedule: isSequential ? "sequential" : "parallel",
      },
    });

    const executeItem = async (
      item: BatchPlanItem,
    ): Promise<NormalizedToolOutcome> => {
      const startTime = Date.now();
      const { req, tool, normalizedArguments, admissionError } = item;

      if (admissionError) {
        const cancelled = admissionError.code === "TOOL_CANCELLED";
        this.emitEvent(cancelled ? "tool.cancelled" : "tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: admissionError.message, code: admissionError.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: cancelled
            ? "cancelled-with-no-known-side-effect"
            : "failed-before-known-side-effect",
          ok: false,
          ...(normalizedArguments ? { normalizedArguments } : {}),
          error: { code: admissionError.code, message: admissionError.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (!tool || !normalizedArguments) {
        const err = new AppError(
          "TOOL_NOT_FOUND",
          `Tool '${req.toolName}' is not registered`,
        );
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code: err.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      let polResult: InvocationPolicySnapshot | undefined = item.policy;

      if (!polResult) {
        const err = new AppError(
          "TOOL_POLICY_DENIED",
          `Policy returned invalid authority for tool '${req.toolName}'`,
        );
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code: err.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          normalizedArguments,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (polResult.decision === "deny") {
        const err = new AppError(
          "TOOL_POLICY_DENIED",
          `Policy denied tool '${req.toolName}': ${polResult.reason}`,
        );
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code: err.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          normalizedArguments,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (
        tool.effectClassification === "side-effecting" &&
        polResult.decision !== "require-approval"
      ) {
        const err = new AppError(
          "TOOL_POLICY_DENIED",
          `Side-effecting tool '${req.toolName}' requires explicit approval authority`,
        );
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code: err.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          normalizedArguments,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (polResult.decision === "require-approval" && !item.approvalGated) {
        const err = new AppError(
          "TOOL_APPROVAL_DENIED",
          `Tool '${req.toolName}' did not complete approval admission`,
        );
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code: err.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          normalizedArguments,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      const execContext = item.executionContext;
      if (!execContext) {
        const err = new AppError(
          "TOOL_IMPLEMENTATION_FAILED",
          `Tool '${req.toolName}' did not complete admission`,
        );
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          normalizedArguments,
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (signal?.aborted) {
        this.emitEvent("tool.cancelled", runId, {
          toolCallId: req.toolCallId,
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "cancelled-with-no-known-side-effect",
          ok: false,
          normalizedArguments,
          error: {
            code: "TOOL_CANCELLED",
            message: "Tool execution was cancelled before start",
          },
          durationMs: Date.now() - startTime,
        };
      }

      type InvocationPhase =
        | "prepared"
        | "implementation-io-started"
        | "side-effect-possible";
      let phase: InvocationPhase = "prepared";
      let sealed = false;
      let markerViolation: AppError | undefined;
      try {
        const timeoutMs = Math.min(tool.timeoutMs, this.limits.toolTimeoutMs);
        const invocationController = new AbortController();
        const markIoStarted = (): void => {
          if (sealed || phase !== "prepared") return;
          phase = "implementation-io-started";
          this.emitEvent("tool.started", runId, {
            toolCallId: req.toolCallId,
            data: { toolName: req.toolName },
          });
        };
        const markSideEffectPossible = (): void => {
          if (sealed || phase === "side-effect-possible") return;
          if (tool.effectClassification !== "side-effecting") {
            markerViolation = new AppError(
              "TOOL_IMPLEMENTATION_FAILED",
              `Read-only tool '${req.toolName}' attempted a side effect`,
            );
            throw markerViolation;
          }
          if (phase !== "implementation-io-started") {
            markerViolation = new AppError(
              "TOOL_IMPLEMENTATION_FAILED",
              `Tool '${req.toolName}' marked a side effect before implementation I/O`,
            );
            throw markerViolation;
          }
          phase = "side-effect-possible";
        };
        // AbortSignal mutates internally when its controller aborts, so it
        // must not pass through deepFreeze with the immutable admission data.
        const invocationContext: ToolExecutionContext = {
          ...execContext,
          signal: invocationController.signal,
          markIoStarted,
          markSideEffectPossible,
        };
        type InvocationResolution =
          | { kind: "result"; result: unknown }
          | { kind: "error"; error: unknown }
          | { kind: "cancelled" }
          | { kind: "timeout" };
        let resolved = false;
        let resolveInvocation!: (resolution: InvocationResolution) => void;
        const invocation = new Promise<InvocationResolution>((resolve) => {
          resolveInvocation = resolve;
        });
        const resolveOnce = (resolution: InvocationResolution): void => {
          if (resolved) return;
          resolved = true;
          sealed = true;
          if (resolution.kind === "cancelled" || resolution.kind === "timeout") {
            invocationController.abort();
          }
          resolveInvocation(resolution);
        };
        const parentAbortListener = () => resolveOnce({ kind: "cancelled" });
        signal?.addEventListener("abort", parentAbortListener, { once: true });
        if (signal?.aborted) resolveOnce({ kind: "cancelled" });
        const timer = setTimeout(
          () => resolveOnce({ kind: "timeout" }),
          timeoutMs,
        );

        Promise.resolve()
          .then(() => {
            if (resolved) return undefined;
            return this.registry.execute(
              req.toolName,
              normalizedArguments,
              invocationContext,
            );
          })
          .then(
            (result) => resolveOnce({ kind: "result", result }),
            (error: unknown) => resolveOnce({ kind: "error", error }),
          );

        let resolution: InvocationResolution;
        try {
          resolution = await invocation;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", parentAbortListener);
        }

        if (resolution.kind === "cancelled") {
          throw new AppError("TOOL_CANCELLED", "Tool execution was cancelled");
        }
        if (resolution.kind === "timeout") {
          throw new AppError(
            "TOOL_EXECUTION_TIMEOUT",
            `Execution of tool '${req.toolName}' timed out after ${timeoutMs}ms`,
          );
        }
        if (resolution.kind === "error") {
          throw resolution.error;
        }
        const result = resolution.result;

        if (markerViolation) throw markerViolation;

        const resVal = this.registry.validateResult(req.toolName, result);
        if (!resVal.ok) {
          throw new AppError(
            "TOOL_IMPLEMENTATION_FAILED",
            `Tool '${req.toolName}' returned invalid result schema: ${resVal.error}`,
          );
        }

        const resBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        if (resBytes > this.limits.maxToolResultBytes) {
          throw new AppError(
            "TOOL_RESULT_TOO_LARGE",
            `Tool result size ${resBytes} bytes exceeds limit ${this.limits.maxToolResultBytes}`,
          );
        }

        this.emitEvent("tool.completed", runId, {
          toolCallId: req.toolCallId,
        });

        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "completed",
          ok: true,
          normalizedArguments,
          result,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        sealed = true;
        const isCancellation =
          err instanceof AppError && err.code === "TOOL_CANCELLED";
        const causeCode =
          err instanceof AppError ? err.code : "TOOL_IMPLEMENTATION_FAILED";
        const isUncertain =
          (phase as InvocationPhase) === "side-effect-possible";
        const isSafelyCancelled = isCancellation && !isUncertain;
        const code = isUncertain ? "TOOL_OUTCOME_UNCERTAIN" : causeCode;
        const terminalState: TerminalToolState = isUncertain
            ? "outcome-uncertain"
            : isSafelyCancelled
              ? "cancelled-with-no-known-side-effect"
            : "failed-before-known-side-effect";

        this.emitEvent(isSafelyCancelled ? "tool.cancelled" : "tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code, ...(isUncertain ? { causeCode } : {}) },
        });

        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState,
          ok: false,
          normalizedArguments,
          error: {
            code,
            message: err.message ?? "Tool execution failed",
            ...(isUncertain ? { causeCode } : {}),
          },
          durationMs: Date.now() - startTime,
        };
      }
    };

    let outcomes: NormalizedToolOutcome[] = [];

    if (isSequential) {
      for (const item of plannedItems) {
        if (signal?.aborted) {
          outcomes.push({
            toolCallId: item.req.toolCallId,
            toolName: item.req.toolName,
            ordinal: item.req.ordinal,
            terminalState: "cancelled-with-no-known-side-effect",
            ok: false,
            ...(item.normalizedArguments
              ? { normalizedArguments: item.normalizedArguments }
              : {}),
            error: {
              code: "TOOL_CANCELLED",
              message: "Tool batch execution was cancelled",
            },
            durationMs: 0,
          });
          continue;
        }

        const outcome = await executeItem(item);
        outcomes.push(outcome);

        if (
          !outcome.ok &&
          item.tool?.effectClassification === "side-effecting"
        ) {
          for (const laterItem of plannedItems.slice(outcomes.length)) {
            outcomes.push({
              toolCallId: laterItem.req.toolCallId,
              toolName: laterItem.req.toolName,
              ordinal: laterItem.req.ordinal,
              terminalState: "not-started",
              ok: false,
              ...(laterItem.normalizedArguments
                ? { normalizedArguments: laterItem.normalizedArguments }
                : {}),
              error: {
                code: "TOOL_CANCELLED",
                message:
                  "Tool batch did not start after an earlier side-effecting failure",
              },
              durationMs: 0,
            });
          }
          break;
        }
      }
    } else {
      outcomes = new Array(plannedItems.length);
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = nextIndex++;
          if (index >= plannedItems.length) return;
          outcomes[index] = await executeItem(plannedItems[index]!);
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              this.limits.maxConcurrentToolCalls,
              plannedItems.length,
            ),
          },
          worker,
        ),
      );
    }

    this.emitEvent("tool.batch.completed", runId, {
      data: { count: outcomes.length },
    });

    return outcomes;
  }
}
