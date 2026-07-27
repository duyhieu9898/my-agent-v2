import { randomIdFactory } from "../core/identities.js";
import { AppError } from "../core/errors.js";
import type { SessionResolver } from "../sessions/session-resolver.js";
import type { SessionKeyInput } from "../sessions/session-key.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { TranscriptContinuation } from "../sessions/transcript-entry.js";
import type { RunJournalStore } from "./run-journal-store.js";
import type {
  RunStore,
  TerminalCommitPlan,
  TerminalFinalizationPlan,
  TerminalStatus,
} from "./run-store.js";
import type { AttemptStore } from "./attempt-store.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
import type { RuntimeCapacity } from "./runtime-capacity.js";
import type { RuntimeEventBus } from "./runtime-events.js";
import {
  CheckpointStage,
  FinalizeStage,
  type StageResult,
} from "./lifecycle.js";
import { BuiltinStepHarness } from "./harness.js";
import { AgentRegistry } from "./agent-registry.js";
import { prepareModelContext } from "../context/prepared-model-context.js";
import { ModelProviderError, type ModelProvider } from "../models/contracts.js";
import type { UsageBudgetGate } from "../usage/usage-budget-gate.js";

export type RunRequest = {
  agentId?: string;
  session: SessionKeyInput;
  input: string;
};

export type RuntimeLifecycleProbe = {
  record(input: Readonly<{ runId: string; step: string }>): void;
};
export class AgentRuntime {
  private readonly cancellations = new Map<
    string,
    {
      cancelLane(): void;
      controller: AbortController;
      attemptId: string | undefined;
      commitFinalization(plan: TerminalFinalizationPlan): Promise<void>;
      checkpoint(
        signal: "success" | "failure" | "cancel",
        code?: string,
      ): Promise<void>;
    }
  >();
  public constructor(
    private readonly dependencies: {
      sessions: SessionResolver;
      transcripts: TranscriptStore;
      runs: RunStore;
      attempts?: AttemptStore;
      journal: RunJournalStore;
      events: RuntimeEventBus;
      lanes: SessionRunLaneCoordinator;
      capacity?: RuntimeCapacity;
      runTimeoutMs?: number;
      execute?: (signal: AbortSignal) => Promise<void>;
      provider?: ModelProvider;
      usageBudgetGate?: UsageBudgetGate;
      agentRegistry?: AgentRegistry;
      lifecycleProbe?: RuntimeLifecycleProbe;
    },
  ) {}
  async admit(request: RunRequest): Promise<{ runId: string }> {
    const agentId = request.agentId ?? "primary";
    if (agentId !== "primary" || request.session.agentId !== "primary")
      throw new AppError("DOMAIN_VALIDATION_FAILED", "AGENT_NOT_FOUND");
    const snapshot = (
      this.dependencies.agentRegistry ?? new AgentRegistry()
    ).resolve(agentId);
    const session = await this.dependencies.sessions.resolve(request.session);
    const reservation = this.dependencies.lanes.reserve(
      `${agentId}:${session.key}`,
    );
    const runId = this.nextRunId();
    const now = new Date().toISOString();
    const controller = new AbortController();
    await this.dependencies.runs.create({
      runId,
      agentId,
      sessionKey: session.key,
      sessionId: session.sessionId,
      status: "queued",
      inputText: request.input,
      createdAt: now,
      updatedAt: now,
    });
    this.dependencies.lifecycleProbe?.record({ runId, step: "run.admitted" });
    const finalizer = new FinalizeStage();
    const checkpoint = new CheckpointStage();
    let checkpointed = false;
    let journalAvailable = true;
    const control = {
      cancelLane: reservation.cancel,
      controller,
      attemptId: undefined as string | undefined,
      commitFinalization: async (
        finalizationPlan: TerminalFinalizationPlan,
      ): Promise<void> =>
        finalizer.execute(async () => {
          this.dependencies.lifecycleProbe?.record({
            runId,
            step: "finalize.started",
          });
          const commit = async (candidate: TerminalCommitPlan) => {
            const result =
              await this.dependencies.runs.commitTerminalOutcome(candidate);
            if (result === "conflict")
              throw new AppError(
                "STORAGE_CONFLICT",
                "Terminal state conflicts with the checkpoint plan",
              );
            return result;
          };
          const plan = finalizationPlan.primary;
          let committedPlan = plan;
          try {
            await commit(plan);
          } catch {
            try {
              // Immediate bounded retry: no timer/poll ordering and no new decision.
              await commit(plan);
            } catch {
              committedPlan = finalizationPlan.fallback;
              try {
                await commit(committedPlan);
              } catch (error) {
                this.dependencies.events.emit({
                  schemaVersion: 1,
                  eventName: "run.infrastructure_failed",
                  occurredAt: plan.occurredAt,
                  sourceModule: "agents",
                  agentId,
                  sessionKey: session.key,
                  sessionId: session.sessionId,
                  runId,
                  payload: { code: "STORAGE_UNAVAILABLE" },
                });
                throw error;
              }
            }
          }
          const terminalStatus = committedPlan.runStatus;
          if (journalAvailable) {
            try {
              await this.dependencies.journal.append({
                runId,
                eventName: `finalize.${terminalStatus}`,
                payload: { terminal: terminalStatus },
                occurredAt: plan.occurredAt,
              });
            } catch {
              journalAvailable = false;
              // Finalization diagnostics are secondary: checkpoint has already
              // selected the sole terminal decision and must not be overridden.
            }
          }
          this.dependencies.lifecycleProbe?.record({
            runId,
            step: `run.state.${terminalStatus}.committed`,
          });
          this.dependencies.events.emit({
            schemaVersion: 1,
            eventName: `run.${terminalStatus}`,
            occurredAt: plan.occurredAt,
            sourceModule: "agents",
            agentId,
            sessionKey: session.key,
            sessionId: session.sessionId,
            runId,
            payload: { terminal: true },
          });
          this.dependencies.lifecycleProbe?.record({
            runId,
            step: `runtime-event.run.${terminalStatus}.emitted`,
          });
          this.dependencies.lifecycleProbe?.record({
            runId,
            step: "finalize.completed",
          });
        }),
      checkpoint: async (
        signal: "success" | "failure" | "cancel",
        code?: string,
      ) => {
        if (checkpointed) return;
        checkpointed = true;
        this.dependencies.lifecycleProbe?.record({
          runId,
          step: "checkpoint.entered",
        });
        let decision = checkpoint.decideSignal({
          kind: signal,
          ...(code ? { code } : {}),
        });
        let terminalCode = code;
        try {
          await this.dependencies.journal.append({
            runId,
            eventName: "checkpoint.decision",
            payload: { decision, signal, ...(code ? { code } : {}) },
            occurredAt: new Date().toISOString(),
          });
        } catch {
          journalAvailable = false;
          decision = "fail";
          terminalCode = "RUN_JOURNAL_FAILED";
        }
        this.dependencies.lifecycleProbe?.record({
          runId,
          step: `checkpoint.decision.${decision}`,
        });
        const status: TerminalStatus =
          decision === "complete"
            ? "completed"
            : decision === "cancel"
              ? "cancelled"
              : "failed";
        const checkpointPlan: TerminalCommitPlan = Object.freeze({
          runId,
          ...(control.attemptId && this.dependencies.attempts
            ? { attemptId: control.attemptId }
            : {}),
          runStatus: status,
          attemptStatus: status,
          occurredAt: new Date().toISOString(),
          ...(status === "completed"
            ? {}
            : {
                terminalCode:
                  terminalCode ??
                  (status === "cancelled" ? "CANCELLED" : "RUN_FAILED"),
              }),
        });
        await control.commitFinalization(
          Object.freeze({
            primary: checkpointPlan,
            fallback: Object.freeze({
              ...checkpointPlan,
              runStatus: "failed",
              attemptStatus: "failed",
              terminalCode: "TERMINAL_COMMIT_FAILED",
            }),
          }),
        );
      },
    };
    this.cancellations.set(runId, control);
    reservation.enqueue(async () => {
      if (controller.signal.aborted) return;
      const release = this.dependencies.capacity
        ? await this.dependencies.capacity.acquire()
        : undefined;
      try {
        await this.dependencies.runs.updateStatus(
          runId,
          "running",
          new Date().toISOString(),
        );
        control.attemptId = randomIdFactory.nextAttemptId();
        if (this.dependencies.attempts) {
          await this.dependencies.attempts.create(
            control.attemptId,
            runId,
            new Date().toISOString(),
          );
        }
        await this.dependencies.journal.append({
          runId,
          eventName: "run.accepted",
          payload: {
            sessionId: session.sessionId,
            agentRevision: snapshot.agentRevision,
          },
          occurredAt: new Date().toISOString(),
        });
        const page = await this.dependencies.transcripts.readPage(
          session.sessionId,
          { limit: 1_000 },
        );
        let assistantText: string | undefined;
        let continuation: TranscriptContinuation | undefined;
        let assistantModelCallId: string | undefined;
        const continuations = [] as Array<{
          providerId: "gemini-developer";
          modelId: "gemini-3.5-flash";
          modelCallId: string;
          version: "gemini-thought-signature-v1";
          payload: Uint8Array;
        }>;
        for (const entry of page.entries) {
          if (entry.type !== "message" || entry.role !== "assistant") continue;
          const continuation =
            await this.dependencies.transcripts.readContinuation(
              session.sessionId,
              entry.sequence,
            );
          if (entry.continuationRequired && !continuation)
            throw new AppError(
              "MODEL_HISTORY_INCOMPATIBLE",
              "Required provider continuation is missing",
            );
          if (!continuation) continue;
          if (!isValidGeminiContinuation(continuation))
            throw new AppError(
              "MODEL_HISTORY_INCOMPATIBLE",
              "Stored provider continuation is incompatible",
            );
          if (
            !entry.continuationRequired ||
            !entry.modelCallId ||
            continuation.modelCallId !== entry.modelCallId
          )
            throw new AppError(
              "MODEL_HISTORY_INCOMPATIBLE",
              "Provider continuation model-call association is incompatible",
            );
          continuations.push({
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            modelCallId: continuation.modelCallId,
            version: "gemini-thought-signature-v1",
            payload: continuation.payload,
          });
        }
        if (this.dependencies.provider) {
          if (!this.dependencies.usageBudgetGate)
            throw new AppError(
              "USAGE_RESERVATION_FAILED",
              "UsageBudgetGate is required for provider dispatch",
            );
          const context = prepareModelContext({
            history: page.entries,
            input: request.input,
            continuations,
          });
          const modelCallId = randomIdFactory.nextModelCallId();
          assistantModelCallId = modelCallId;
          const usage = await this.dependencies.usageBudgetGate.reserve({
            modelCallId,
            agentId,
            sessionId: session.sessionId,
            runId,
            attemptId: control.attemptId,
            providerId: "gemini-developer",
            modelId: "gemini-3.5-flash",
            estimatedTokens: BigInt(request.input.length),
            occurredAt: new Date().toISOString(),
          });
          await this.dependencies.journal.append({
            runId,
            eventName: "usage.reserved",
            payload: { modelCallId },
            occurredAt: new Date().toISOString(),
          });
          await this.dependencies.usageBudgetGate.markDispatched(
            usage.usageReservationId,
            new Date().toISOString(),
          );
          try {
            const output = await this.withTimeout(
              new BuiltinStepHarness().executeStep({
                provider: this.dependencies.provider,
                modelCallId,
                context,
                signal: controller.signal,
              }),
              controller,
            );
            assistantText = output.text;
            if (output.requiresContinuation && !output.continuation)
              throw new AppError(
                "MODEL_HISTORY_INCOMPATIBLE",
                "Required provider continuation is missing",
              );
            if (
              output.continuation &&
              (!output.continuation.version ||
                !output.continuation.payload.length ||
                output.continuation.version !== "gemini-thought-signature-v1")
            )
              throw new AppError(
                "MODEL_HISTORY_INCOMPATIBLE",
                "Provider continuation is malformed",
              );
            if (output.continuation)
              continuation = {
                ...output.continuation,
                providerId: "gemini-developer",
                modelId: "gemini-3.5-flash",
                modelCallId,
              };
            await this.dependencies.journal.append({
              runId,
              eventName: "model.completed",
              payload: { modelCallId },
              occurredAt: new Date().toISOString(),
            });
            if (
              output.billingCertainty === "actual-known" &&
              output.usage.providerTotalTokens !== undefined &&
              output.usage.inputTokens !== undefined &&
              output.usage.outputTokens !== undefined
            )
              await this.dependencies.usageBudgetGate.settle(
                usage,
                output.usage,
                new Date().toISOString(),
              );
            else
              await this.dependencies.usageBudgetGate.markUncertain(
                usage,
                new Date().toISOString(),
              );
          } catch (error) {
            if (
              error instanceof ModelProviderError &&
              (error.billingCertainty === "not-billable" ||
                error.billingCertainty === "not-dispatched")
            )
              await this.dependencies.usageBudgetGate.release(
                usage,
                new Date().toISOString(),
              );
            else
              await this.dependencies.usageBudgetGate.markUncertain(
                usage,
                new Date().toISOString(),
              );
            throw error;
          }
        } else await this.executeWithTimeout(controller);
        const result: StageResult = { kind: "ok" };
        if (
          checkpoint.decide({
            cancelled: controller.signal.aborted,
            result,
          }) === "cancel"
        ) {
          await control.checkpoint("cancel", "CANCELLED");
          return;
        }
        await this.dependencies.transcripts.appendBatch({
          sessionId: session.sessionId,
          expectedTailSequence: page.entries.at(-1)?.sequence ?? 0,
          entries: [
            {
              type: "message",
              id: `input-${runId}`,
              role: "user",
              text: request.input,
              createdAt: new Date().toISOString(),
            },
            ...(assistantText === undefined
              ? []
              : [
                  {
                    type: "message" as const,
                    id: `output-${runId}`,
                    role: "assistant" as const,
                    text: assistantText,
                    createdAt: new Date().toISOString(),
                    ...(continuation ? { continuation } : {}),
                    ...(continuation ? { continuationRequired: true } : {}),
                    ...(continuation && assistantModelCallId
                      ? { modelCallId: assistantModelCallId }
                      : {}),
                  },
                ]),
          ],
        });
        if (
          checkpoint.decide({
            cancelled: controller.signal.aborted,
            result,
          }) === "cancel"
        ) {
          await control.checkpoint("cancel", "CANCELLED");
          return;
        }
        await control.checkpoint("success");
      } catch (error) {
        try {
          await control.checkpoint(
            controller.signal.aborted &&
              !(error instanceof Error && error.message === "RUN_TIMEOUT")
              ? "cancel"
              : "failure",
            error instanceof AppError ? error.code : "RUN_FAILED",
          );
        } catch {
          // A required finalization write failed; leave durable recovery evidence intact.
        }
      } finally {
        release?.();
        this.cancellations.delete(runId);
      }
    });
    return { runId };
  }
  async cancel(runId: string): Promise<boolean> {
    const cancellation = this.cancellations.get(runId);
    if (!cancellation) return false;
    cancellation.controller.abort();
    cancellation.cancelLane();
    await cancellation.checkpoint("cancel", "CANCELLED");
    this.cancellations.delete(runId);
    return true;
  }
  private nextRunId(): string {
    return randomIdFactory.nextRunId();
  }

  private async executeWithTimeout(controller: AbortController): Promise<void> {
    const execution = this.dependencies.execute?.(controller.signal);
    if (!execution || !this.dependencies.runTimeoutMs) return execution;
    await this.withTimeout(execution, controller);
  }

  private async withTimeout<T>(
    execution: Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    if (!this.dependencies.runTimeoutMs) return execution;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (!controller.signal.aborted) {
              controller.abort();
              reject(new Error("RUN_TIMEOUT"));
            }
          }, this.dependencies.runTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function isValidGeminiContinuation(value: {
  version: string;
  payload: Uint8Array;
  providerId?: string;
  modelId?: string;
  modelCallId?: string;
}): boolean {
  if (
    value.version !== "gemini-thought-signature-v1" ||
    !value.payload.length ||
    value.providerId !== "gemini-developer" ||
    value.modelId !== "gemini-3.5-flash" ||
    !value.modelCallId
  )
    return false;
  try {
    return (
      new TextDecoder("utf-8", { fatal: true }).decode(value.payload).trim()
        .length > 0
    );
  } catch {
    return false;
  }
}
