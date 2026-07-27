import { randomIdFactory } from "../core/identities.js";
import { AppError } from "../core/errors.js";
import type { SessionResolver } from "../sessions/session-resolver.js";
import type { SessionKeyInput } from "../sessions/session-key.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { SqliteRunJournalStore } from "./run-journal-store.js";
import type { SqliteRunStore } from "./run-store.js";
import type { SqliteAttemptStore } from "./attempt-store.js";
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
export class AgentRuntime {
  private readonly cancellations = new Map<
    string,
    {
      cancelLane(): void;
      controller: AbortController;
      finalize: FinalizeStage;
      attemptId: string | undefined;
      terminalize(
        status: "completed" | "failed" | "cancelled",
        code?: string,
      ): Promise<void>;
    }
  >();
  public constructor(
    private readonly dependencies: {
      sessions: SessionResolver;
      transcripts: TranscriptStore;
      runs: SqliteRunStore;
      attempts?: SqliteAttemptStore;
      journal: SqliteRunJournalStore;
      events: RuntimeEventBus;
      lanes: SessionRunLaneCoordinator;
      capacity?: RuntimeCapacity;
      runTimeoutMs?: number;
      execute?: (signal: AbortSignal) => Promise<void>;
      provider?: ModelProvider;
      usageBudgetGate?: UsageBudgetGate;
      agentRegistry?: AgentRegistry;
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
    const finalizer = new FinalizeStage();
    const control = {
      cancelLane: reservation.cancel,
      controller,
      finalize: finalizer,
      attemptId: undefined as string | undefined,
      terminalize: async (
        status: "completed" | "failed" | "cancelled",
        code?: string,
      ): Promise<void> =>
        finalizer.execute(async () => {
          const timestamp = new Date().toISOString();
          if (control.attemptId)
            await this.dependencies.attempts?.terminalize(
              control.attemptId,
              status,
              timestamp,
              code,
            );
          await this.dependencies.journal.append({
            runId,
            eventName: `finalize.${status}`,
            payload: { terminal: status },
            occurredAt: timestamp,
          });
          await this.dependencies.runs.updateStatus(
            runId,
            status,
            timestamp,
            code,
          );
          if (status === "completed")
            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "run.completed",
              occurredAt: timestamp,
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              payload: { terminal: true },
            });
        }),
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
        await this.dependencies.attempts?.create(
          control.attemptId,
          runId,
          new Date().toISOString(),
        );
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
        let continuation: { version: string; payload: Uint8Array } | undefined;
        if (this.dependencies.provider) {
          if (!this.dependencies.usageBudgetGate)
            throw new AppError(
              "USAGE_RESERVATION_FAILED",
              "UsageBudgetGate is required for provider dispatch",
            );
          const context = prepareModelContext({
            history: page.entries,
            input: request.input,
          });
          const modelCallId = randomIdFactory.nextModelCallId();
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
                !output.continuation.payload.length)
            )
              throw new AppError(
                "MODEL_HISTORY_INCOMPATIBLE",
                "Provider continuation is malformed",
              );
            if (output.continuation) continuation = output.continuation;
            else if (output.providerInteractionId)
              continuation = {
                version: "gemini-interaction-id-v1",
                payload: new TextEncoder().encode(output.providerInteractionId),
              };
            await this.dependencies.journal.append({
              runId,
              eventName: "model.completed",
              payload: { modelCallId },
              occurredAt: new Date().toISOString(),
            });
            if (output.billingCertainty === "actual-known")
              await this.dependencies.usageBudgetGate.settle(
                usage,
                output.usage,
                new Date().toISOString(),
              );
            else if (output.billingCertainty === "billing-ambiguous")
              await this.dependencies.usageBudgetGate.markUncertain(
                usage,
                new Date().toISOString(),
              );
            else
              await this.dependencies.usageBudgetGate.release(
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
        const checkpoint = new CheckpointStage();
        const result: StageResult = { kind: "ok" };
        if (
          checkpoint.decide({
            cancelled: controller.signal.aborted,
            result,
          }) === "cancel"
        ) {
          await control.terminalize("cancelled", "CANCELLED");
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
          await control.terminalize("cancelled", "CANCELLED");
          return;
        }
        await control.terminalize("completed");
      } catch {
        try {
          await control.terminalize("failed", "RUN_FAILED");
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
    await cancellation.terminalize("cancelled", "CANCELLED");
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
