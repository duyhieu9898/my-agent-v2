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

import type { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import type { WorkspacePolicy } from "../policy/workspace-policy.js";
import type {
  NormalizedToolOutcome,
  NormalizedToolRequest,
  TerminalToolState,
  ToolDescriptor,
  ToolExecutionContext,
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
    const { runId, workspaceRoot } = batchContext;

    if (requests.length > this.limits.maxToolCallsPerBatch) {
      throw new AppError(
        "TOOL_BUDGET_EXHAUSTED",
        `Batch size ${requests.length} exceeds maximum allowed tool calls per batch (${this.limits.maxToolCallsPerBatch})`,
      );
    }

    if (
      batchContext.totalRunToolCalls + requests.length >
      this.limits.maxToolCallsPerRun
    ) {
      throw new AppError(
        "TOOL_BUDGET_EXHAUSTED",
        `Run tool calls ${batchContext.totalRunToolCalls + requests.length} exceeds maximum per run (${this.limits.maxToolCallsPerRun})`,
      );
    }

    this.emitEvent("tool.batch.planned", runId, {
      data: { count: requests.length },
    });

    const plannedItems: Array<{
      req: NormalizedToolRequest;
      tool?: ToolDescriptor;
      argError?: AppError;
    }> = [];

    for (const req of requests) {
      this.emitEvent("tool.requested", runId, {
        toolCallId: req.toolCallId,
        data: { toolName: req.toolName, ordinal: req.ordinal },
      });

      const argBytes = Buffer.byteLength(
        JSON.stringify(req.rawArguments),
        "utf8",
      );
      if (argBytes > this.limits.maxToolArgumentBytes) {
        plannedItems.push({
          req,
          argError: new AppError(
            "TOOL_ARGUMENTS_INVALID",
            `Tool arguments size ${argBytes} bytes exceeds limit ${this.limits.maxToolArgumentBytes}`,
          ),
        });
        continue;
      }

      const tool = this.registry.get(req.toolName);
      if (!tool) {
        plannedItems.push({
          req,
          argError: new AppError(
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
          argError: new AppError(
            "TOOL_ARGUMENTS_INVALID",
            `Invalid arguments for tool '${req.toolName}': ${argVal.error}`,
          ),
        });
        continue;
      }

      plannedItems.push({ req, tool });
    }

    const allParallelSafeRead = plannedItems.every(
      (item) =>
        item.tool?.effectClassification === "read-only" &&
        item.tool?.concurrencyTrait === "parallel-safe",
    );

    const isSequential = !allParallelSafeRead;

    const executeItem = async (item: {
      req: NormalizedToolRequest;
      tool?: ToolDescriptor;
      argError?: AppError;
    }): Promise<NormalizedToolOutcome> => {
      const startTime = Date.now();
      const { req, tool, argError } = item;

      if (argError) {
        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: argError.message, code: argError.code },
        });
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState: "failed-before-known-side-effect",
          ok: false,
          error: { code: argError.code, message: argError.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (!tool) {
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

      const polResult = await this.policy.evaluateInvocation(
        tool,
        req.rawArguments,
        workspaceRoot,
      );

      this.emitEvent("policy.evaluated", runId, {
        toolCallId: req.toolCallId,
        data: {
          decision: polResult.decision,
          reason: polResult.reason,
        },
      });

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
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        };
      }

      if (polResult.decision === "require-approval") {
        const actionSummary = tool.approvalSummaryRenderer(req.rawArguments);

        const approvalStatus = await this.approvalCoordinator.requestApproval({
          agentId: batchContext.agentId,
          sessionKey: batchContext.sessionKey,
          sessionId: batchContext.sessionId,
          runId: batchContext.runId,
          attemptId: batchContext.attemptId,
          modelCallId: batchContext.modelCallId,
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          rawArguments: req.rawArguments,
          executionTarget: tool.executionTarget,
          sandboxProfile: tool.sandboxRequirement,
          actionSummary,
          policyProfile: polResult.policyProfile,
          reason: polResult.reason,
          timeoutMs: this.limits.approvalTimeoutMs,
          ...(signal ? { signal } : {}),
        });

        this.emitEvent("approval.resolved", runId, {
          toolCallId: req.toolCallId,
          data: { status: approvalStatus },
        });

        if (approvalStatus !== "allowed") {
          const code =
            approvalStatus === "expired"
              ? "TOOL_APPROVAL_EXPIRED"
              : approvalStatus === "cancelled"
                ? "TOOL_CANCELLED"
                : "TOOL_APPROVAL_DENIED";
          const err = new AppError(
            code,
            `Approval for tool '${req.toolName}' was ${approvalStatus}`,
          );
          this.emitEvent("tool.failed", runId, {
            toolCallId: req.toolCallId,
            data: { error: err.message, code: err.code },
          });
          return {
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            ordinal: req.ordinal,
            terminalState:
              approvalStatus === "cancelled"
                ? "cancelled-with-no-known-side-effect"
                : "failed-before-known-side-effect",
            ok: false,
            error: { code: err.code, message: err.message },
            durationMs: Date.now() - startTime,
          };
        }

        const recheckPolicy = await this.policy.evaluateInvocation(
          tool,
          req.rawArguments,
          workspaceRoot,
        );
        if (recheckPolicy.decision === "deny") {
          const err = new AppError(
            "TOOL_POLICY_DENIED",
            `Policy denied tool '${req.toolName}' on recheck: ${recheckPolicy.reason}`,
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
      }

      const execContext: ToolExecutionContext = {
        agentId: batchContext.agentId,
        workspaceRoot,
        targetPath: (req.rawArguments["path"] as string) ?? "",
        toolCallId: req.toolCallId,
        deadline:
          Date.now() + Math.min(tool.timeoutMs, this.limits.toolTimeoutMs),
        ...(signal ? { signal } : {}),
        inputLimits: tool.inputLimits,
        outputLimits: tool.outputLimits,
        policyConstraints: {},
        sandboxProfile: tool.sandboxRequirement,
      };

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
          error: {
            code: "TOOL_CANCELLED",
            message: "Tool execution was cancelled before start",
          },
          durationMs: Date.now() - startTime,
        };
      }

      this.emitEvent("tool.started", runId, {
        toolCallId: req.toolCallId,
        data: { toolName: req.toolName },
      });

      let sideEffectStarted = tool.effectClassification === "side-effecting";

      try {
        const timeoutMs = Math.min(tool.timeoutMs, this.limits.toolTimeoutMs);
        let timer: NodeJS.Timeout;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new AppError(
                "TOOL_EXECUTION_TIMEOUT",
                `Execution of tool '${req.toolName}' timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });

        const result = await Promise.race([
          tool.execute(req.rawArguments, execContext),
          timeoutPromise,
        ]).finally(() => {
          clearTimeout(timer!);
        });

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
          result,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        const isUncertain = sideEffectStarted;
        const code =
          err instanceof AppError
            ? err.code
            : isUncertain
              ? "TOOL_OUTCOME_UNCERTAIN"
              : "TOOL_IMPLEMENTATION_FAILED";
        const terminalState: TerminalToolState = isUncertain
          ? "outcome-uncertain"
          : "failed-before-known-side-effect";

        this.emitEvent("tool.failed", runId, {
          toolCallId: req.toolCallId,
          data: { error: err.message, code },
        });

        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ordinal: req.ordinal,
          terminalState,
          ok: false,
          error: { code, message: err.message ?? "Tool execution failed" },
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
          break;
        }
      }
    } else {
      outcomes = await Promise.all(
        plannedItems.map((item) => executeItem(item)),
      );
    }

    outcomes.sort((a, b) => a.ordinal - b.ordinal);

    this.emitEvent("tool.batch.completed", runId, {
      data: { count: outcomes.length },
    });

    return outcomes;
  }
}
