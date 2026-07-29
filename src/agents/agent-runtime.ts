import { AppError } from "../core/errors.js";
import {
  createAgentId,
  createAttemptId,
  createModelCallId,
  createRunId,
  createToolCallId,
  randomIdFactory,
} from "../core/identities.js";
import type { SessionKeyInput } from "../sessions/session-key.js";
import type { SessionResolver } from "../sessions/session-resolver.js";

import type { AttemptStore } from "./attempt-store.js";
import type { RunJournalStore } from "./run-journal-store.js";
import type {
  RunStore,
  TerminalCommitPlan,
  TerminalFinalizationPlan,
  TerminalStatus,
} from "./run-store.js";
import type { RuntimeCapacity } from "./runtime-capacity.js";
import type { RuntimeEventBus } from "./runtime-events.js";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";

import type { AgentRegistry } from "./agent-registry.js";

import { prepareModelContext } from "../context/prepared-model-context.js";
import type { HarnessRegistry } from "./harness-registry.js";
import {
  CheckpointStage,
  FinalizeStage,
  type StageResult,
} from "./lifecycle.js";

import { ModelProviderError, type ModelProvider } from "../models/contracts.js";
import type { TokenEstimator } from "../models/token-estimator.js";
import type { WorkspacePolicy } from "../policy/workspace-policy.js";
import type {
  TranscriptContinuation,
  TranscriptEntry,
} from "../sessions/transcript-entry.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { NormalizedToolRequest } from "../tools/contracts.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";
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
      agentRegistry: AgentRegistry;
      harnessRegistry: HarnessRegistry;
      tokenEstimator: TokenEstimator;
      toolRuntime?: ToolRuntime;
      toolRegistry?: ToolRegistry;
      workspacePolicy?: WorkspacePolicy;
      workspaceRoot?: string;
      lifecycleProbe?: RuntimeLifecycleProbe;
    },
  ) {
    if (this.dependencies.toolRuntime) {
      this.dependencies.toolRuntime.onEvent((evt) => {
        this.dependencies.events.emit({
          schemaVersion: 1,
          eventName: evt.type as any,
          occurredAt: new Date().toISOString(),
          sourceModule: "agents",
          runId: evt.runId,
          ...(evt.toolCallId ? { toolCallId: evt.toolCallId } : {}),
          ...(evt.approvalId ? { approvalId: evt.approvalId } : {}),
          payload: {
            ...(evt.approvalId ? { approvalId: evt.approvalId } : {}),
            ...(evt.data ?? {}),
          },
        });
      });
    }
  }

  async admit(request: RunRequest): Promise<{ runId: string }> {
    const agentId = request.agentId ?? "primary";
    const snapshot = this.dependencies.agentRegistry.resolve(agentId);
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

    this.dependencies.events.emit({
      schemaVersion: 1,
      eventName: "run.queued",
      occurredAt: now,
      sourceModule: "agents",
      agentId,
      sessionKey: session.key,
      sessionId: session.sessionId,
      runId,
      payload: { status: "queued" },
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
          const plan = finalizationPlan.primary;
          this.dependencies.events.emit({
            schemaVersion: 1,
            eventName: "finalize.started",
            occurredAt: plan.occurredAt,
            sourceModule: "agents",
            agentId,
            sessionKey: session.key,
            sessionId: session.sessionId,
            runId,
            payload: { terminalStatus: plan.runStatus },
          });

          if (journalAvailable) {
            try {
              await this.dependencies.journal.append({
                runId,
                eventName: "finalize.started",
                payload: { terminalStatus: plan.runStatus },
                occurredAt: plan.occurredAt,
              });
            } catch {
              journalAvailable = false;
            }
          }

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

          let committedPlan = plan;
          try {
            await commit(plan);
          } catch {
            try {
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
              await this.dependencies.journal.append({
                runId,
                eventName: `run.${terminalStatus}`,
                payload: { terminal: terminalStatus },
                occurredAt: plan.occurredAt,
              });
            } catch {
              journalAvailable = false;
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

        this.dependencies.events.emit({
          schemaVersion: 1,
          eventName: "run.started",
          occurredAt: new Date().toISOString(),
          sourceModule: "agents",
          agentId,
          sessionKey: session.key,
          sessionId: session.sessionId,
          runId,
          payload: { status: "running" },
        });

        this.dependencies.events.emit({
          schemaVersion: 1,
          eventName: "attempt.started",
          occurredAt: new Date().toISOString(),
          sourceModule: "agents",
          agentId,
          sessionKey: session.key,
          sessionId: session.sessionId,
          runId,
          attemptId: control.attemptId,
          payload: { attemptId: control.attemptId },
        });

        this.dependencies.events.emit({
          schemaVersion: 1,
          eventName: "stage.started",
          occurredAt: new Date().toISOString(),
          sourceModule: "agents",
          agentId,
          sessionKey: session.key,
          sessionId: session.sessionId,
          runId,
          attemptId: control.attemptId,
          payload: { stagePhase: "setup", stageId: "setup" },
        });

        if (journalAvailable) {
          try {
            await this.dependencies.journal.append({
              runId,
              eventName: "attempt.started",
              payload: { attemptId: control.attemptId },
              occurredAt: new Date().toISOString(),
            });
            await this.dependencies.journal.append({
              runId,
              eventName: "stage.started",
              payload: { stagePhase: "setup", stageId: "setup" },
              occurredAt: new Date().toISOString(),
            });
          } catch {
            journalAvailable = false;
          }
        }

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
            resourceManifestHash: snapshot.resourceManifestHash,
            providerId: snapshot.modelRoute.providerId,
            modelId: snapshot.modelRoute.modelId,
            harnessId: snapshot.harnessId,
            promptProfile: snapshot.promptProfile,
            toolProfile: snapshot.toolProfile,
            memoryProfile: snapshot.memoryProfile,
            tokenEstimatorRevision: snapshot.tokenEstimatorRevision,
            contextTokenBudget: snapshot.contextTokenBudget,
            toolRegistryFingerprint: snapshot.toolRegistryFingerprint,
            toolPolicyFingerprint: snapshot.toolPolicyFingerprint,
            sandboxPolicyFingerprint: snapshot.sandboxPolicyFingerprint,
            memoryPolicyFingerprint: snapshot.memoryPolicyFingerprint,
          },
          occurredAt: new Date().toISOString(),
        });

        if (this.dependencies.provider) {
          if (!this.dependencies.usageBudgetGate)
            throw new AppError(
              "USAGE_RESERVATION_FAILED",
              "UsageBudgetGate is required for provider dispatch",
            );

          const harness = this.dependencies.harnessRegistry.resolve(
            snapshot.harnessId,
          );

          let iteration = 0;
          const maxToolIterations = 8;
          let totalRunToolCalls = 0;
          let userInputCommitted = false;

          while (iteration < maxToolIterations) {
            const page = await this.dependencies.transcripts.readPage(
              session.sessionId,
              { limit: 1_000 },
            );

            const continuations: Array<{
              providerId: "gemini-developer";
              modelId: "gemini-3.5-flash";
              modelCallId: string;
              version: "gemini-thought-signature-v1";
              payload: Uint8Array;
            }> = [];

            for (const entry of page.entries) {
              if (entry.type !== "message" || entry.role !== "assistant")
                continue;
              const cont = await this.dependencies.transcripts.readContinuation(
                session.sessionId,
                entry.sequence,
              );
              if (entry.continuationRequired && !cont)
                throw new AppError(
                  "MODEL_HISTORY_INCOMPATIBLE",
                  "Required provider continuation is missing",
                );
              if (!cont) continue;
              if (!isValidGeminiContinuation(cont, snapshot.modelRoute))
                throw new AppError(
                  "MODEL_HISTORY_INCOMPATIBLE",
                  "Stored provider continuation is incompatible",
                );
              if (
                !entry.continuationRequired ||
                !entry.modelCallId ||
                cont.modelCallId !== entry.modelCallId
              )
                throw new AppError(
                  "MODEL_HISTORY_INCOMPATIBLE",
                  "Provider continuation model-call association is incompatible",
                );
              continuations.push({
                providerId: snapshot.modelRoute.providerId,
                modelId: snapshot.modelRoute.modelId,
                modelCallId: cont.modelCallId,
                version: "gemini-thought-signature-v1",
                payload: cont.payload,
              });
            }

            const visibleTools =
              this.dependencies.toolRuntime &&
              this.dependencies.workspacePolicy &&
              this.dependencies.toolRegistry
                ? this.dependencies.workspacePolicy.evaluateVisibility(
                    this.dependencies.toolRegistry.list(),
                  )
                : undefined;

            const context = prepareModelContext({
              history: page.entries,
              input: request.input,
              ...(visibleTools ? { tools: visibleTools } : {}),
              continuations,
              promptProfile: snapshot.promptProfile,
            });

            const contextTokens = this.dependencies.tokenEstimator.estimate({
              instructions: context.instructions,
              turns: context.turns,
              continuations: context.continuations,
            });

            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "context.prepared",
              occurredAt: new Date().toISOString(),
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              payload: { estimatedTokens: Number(contextTokens) },
            });

            if (journalAvailable) {
              try {
                await this.dependencies.journal.append({
                  runId,
                  eventName: "context.prepared",
                  payload: { estimatedTokens: Number(contextTokens) },
                  occurredAt: new Date().toISOString(),
                });
              } catch {
                journalAvailable = false;
              }
            }

            if (contextTokens > BigInt(snapshot.contextTokenBudget))
              throw new AppError(
                "CONTEXT_BUDGET_EXCEEDED",
                "Estimated context tokens exceed the configured budget",
                {
                  estimatedTokens: contextTokens.toString(),
                  contextTokenBudget: snapshot.contextTokenBudget,
                },
              );

            const modelCallId = randomIdFactory.nextModelCallId();
            const usage = await this.dependencies.usageBudgetGate.reserve({
              modelCallId,
              agentId,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              providerId: snapshot.modelRoute.providerId,
              modelId: snapshot.modelRoute.modelId,
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

            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "stage.started",
              occurredAt: new Date().toISOString(),
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              modelCallId,
              payload: { stagePhase: "iteration", stageId: "model-step" },
            });

            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "model.requested",
              occurredAt: new Date().toISOString(),
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              modelCallId,
              payload: {
                providerId: snapshot.modelRoute.providerId,
                modelId: snapshot.modelRoute.modelId,
              },
            });

            if (journalAvailable) {
              try {
                await this.dependencies.journal.append({
                  runId,
                  eventName: "stage.started",
                  payload: { stagePhase: "iteration", stageId: "model-step" },
                  occurredAt: new Date().toISOString(),
                });
                await this.dependencies.journal.append({
                  runId,
                  eventName: "model.requested",
                  payload: {
                    modelCallId,
                    providerId: snapshot.modelRoute.providerId,
                    modelId: snapshot.modelRoute.modelId,
                  },
                  occurredAt: new Date().toISOString(),
                });
              } catch {
                journalAvailable = false;
              }
            }

            let output;
            try {
              output = await this.withTimeout(
                harness.executeStep({
                  provider: this.dependencies.provider,
                  modelCallId,
                  context,
                  modelRoute: snapshot.modelRoute,
                  signal: controller.signal,
                }),
                controller,
              );

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

              this.dependencies.events.emit({
                schemaVersion: 1,
                eventName: "model.completed",
                occurredAt: new Date().toISOString(),
                sourceModule: "agents",
                agentId,
                sessionKey: session.key,
                sessionId: session.sessionId,
                runId,
                attemptId: control.attemptId,
                modelCallId,
                payload: {
                  providerId: snapshot.modelRoute.providerId,
                  modelId: snapshot.modelRoute.modelId,
                },
              });

              if (journalAvailable) {
                try {
                  await this.dependencies.journal.append({
                    runId,
                    eventName: "model.completed",
                    payload: { modelCallId },
                    occurredAt: new Date().toISOString(),
                  });
                  if (output.continuation) {
                    await this.dependencies.journal.append({
                      runId,
                      eventName: "model.continuation.persisted",
                      payload: {
                        modelCallId,
                        version: output.continuation.version,
                        payloadLength: output.continuation.payload.length,
                      },
                      occurredAt: new Date().toISOString(),
                    });
                  }
                } catch {
                  journalAvailable = false;
                }
              }

              if (
                output.billingCertainty === "actual-known" &&
                output.usage.providerTotalTokens !== undefined &&
                output.usage.inputTokens !== undefined &&
                output.usage.outputTokens !== undefined
              ) {
                await this.dependencies.usageBudgetGate.settle(
                  usage,
                  output.usage,
                  new Date().toISOString(),
                );
                if (journalAvailable) {
                  try {
                    await this.dependencies.journal.append({
                      runId,
                      eventName: "usage.settled",
                      payload: {
                        usageReservationId: usage.usageReservationId,
                        modelCallId,
                        providerTotalTokens: Number(
                          output.usage.providerTotalTokens,
                        ),
                        inputTokens: Number(output.usage.inputTokens),
                        outputTokens: Number(output.usage.outputTokens),
                      },
                      occurredAt: new Date().toISOString(),
                    });
                  } catch {
                    journalAvailable = false;
                  }
                }
              } else {
                await this.dependencies.usageBudgetGate.markUncertain(
                  usage,
                  new Date().toISOString(),
                );
              }
            } catch (error) {
              this.dependencies.events.emit({
                schemaVersion: 1,
                eventName: "model.failed",
                occurredAt: new Date().toISOString(),
                sourceModule: "agents",
                agentId,
                sessionKey: session.key,
                sessionId: session.sessionId,
                runId,
                attemptId: control.attemptId,
                modelCallId,
                payload: {
                  error:
                    error instanceof Error ? error.message : "MODEL_FAILED",
                },
              });

              if (
                error instanceof ModelProviderError &&
                (error.billingCertainty === "not-billable" ||
                  error.billingCertainty === "not-dispatched")
              ) {
                await this.dependencies.usageBudgetGate.release(
                  usage,
                  new Date().toISOString(),
                );
              } else {
                await this.dependencies.usageBudgetGate.markUncertain(
                  usage,
                  new Date().toISOString(),
                );
              }
              throw error;
            }

            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "stage.completed",
              occurredAt: new Date().toISOString(),
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              modelCallId,
              payload: { stagePhase: "iteration", stageId: "model-step" },
            });

            if (journalAvailable) {
              try {
                await this.dependencies.journal.append({
                  runId,
                  eventName: "stage.completed",
                  payload: { stagePhase: "iteration", stageId: "model-step" },
                  occurredAt: new Date().toISOString(),
                });
              } catch {
                journalAvailable = false;
              }
            }

            // Check if model returned tool calls!
            if (
              output.toolCalls &&
              output.toolCalls.length > 0 &&
              this.dependencies.toolRuntime
            ) {
              const toolRequests: NormalizedToolRequest[] =
                output.toolCalls.map((c, i) => ({
                  toolCallId: randomIdFactory.nextToolCallId(),
                  ...(c.id ? { providerCallId: c.id } : {}),
                  modelCallId: createModelCallId(modelCallId),
                  ordinal: i + 1,
                  toolName: c.name,
                  rawArguments: c.arguments,
                }));

              const outcomes = await this.dependencies.toolRuntime.executeBatch(
                toolRequests,
                {
                  agentId: createAgentId(agentId),
                  sessionKey: session.key,
                  sessionId: session.sessionId,
                  runId: createRunId(runId),
                  attemptId: createAttemptId(control.attemptId!),
                  modelCallId: createModelCallId(modelCallId),
                  workspaceRoot:
                    this.dependencies.workspaceRoot ?? process.cwd(),
                  sandboxProfile: snapshot.sandboxPolicyFingerprint,
                  totalRunToolCalls,
                },
                controller.signal,
              );

              totalRunToolCalls += outcomes.length;

              const cycleDecision = checkpoint.decideToolCycle({
                cancelled: controller.signal.aborted,
                outcomes,
                iterationsCount: iteration + 1,
                maxIterations: maxToolIterations,
              });

              // Check invariant for admitted outcomes before transcript commit
              for (const out of outcomes) {
                if (!out.normalizedArguments) {
                  const isUnadmitted =
                    !out.ok &&
                    out.terminalState === "failed-before-known-side-effect" &&
                    (out.error?.code === "TOOL_NOT_FOUND" ||
                      out.error?.code === "TOOL_ARGUMENTS_INVALID");
                  if (!isUnadmitted) {
                    throw new AppError(
                      "TOOL_IMPLEMENTATION_FAILED",
                      `Admitted tool outcome for '${out.toolName}' missing normalized arguments`,
                    );
                  }
                }
              }

              const batchEntries: TranscriptEntry[] = [];
              if (!userInputCommitted) {
                batchEntries.push({
                  type: "message",
                  id: `input-${runId}`,
                  role: "user",
                  text: request.input,
                  createdAt: new Date().toISOString(),
                });
                userInputCommitted = true;
              }

              for (let i = 0; i < toolRequests.length; i++) {
                const req = toolRequests[i]!;
                const out =
                  outcomes.find((o) => o.toolCallId === req.toolCallId) ??
                  outcomes[i]!;
                batchEntries.push({
                  type: "tool-call",
                  id: `tcall-${req.toolCallId}`,
                  modelCallId,
                  toolCallId: req.toolCallId,
                  toolName: req.toolName,
                  arguments: out.normalizedArguments ?? {},
                  ordinal: req.ordinal,
                  createdAt: new Date().toISOString(),
                });
                batchEntries.push({
                  type: "tool-result",
                  id: `tres-${req.toolCallId}`,
                  toolCallId: req.toolCallId,
                  toolName: req.toolName,
                  content: out.ok ? out.result : { error: out.error },
                  createdAt: new Date().toISOString(),
                });
              }

              await this.dependencies.transcripts.appendBatch({
                sessionId: session.sessionId,
                expectedTailSequence: page.entries.at(-1)?.sequence ?? 0,
                entries: batchEntries,
              });

              if (journalAvailable) {
                try {
                  await this.dependencies.journal.append({
                    runId,
                    eventName: "checkpoint.decision",
                    payload: {
                      decision: cycleDecision,
                      signal: "tool-cycle",
                      iteration: iteration + 1,
                    },
                    occurredAt: new Date().toISOString(),
                  });
                } catch {
                  journalAvailable = false;
                }
              }

              if (cycleDecision === "cancel") {
                await control.checkpoint("cancel", "CANCELLED");
                return;
              }

              if (cycleDecision === "fail") {
                const failedOutcome = outcomes.find((o) => !o.ok);
                const code =
                  failedOutcome?.error?.code ?? "TOOL_EXECUTION_FAILED";
                await control.checkpoint("failure", code);
                return;
              }

              iteration++;
              continue;
            }

            // Model returned text response with no tool calls
            const batchEntries: TranscriptEntry[] = [];
            if (!userInputCommitted) {
              batchEntries.push({
                type: "message",
                id: `input-${runId}`,
                role: "user",
                text: request.input,
                createdAt: new Date().toISOString(),
              });
              userInputCommitted = true;
            }

            if (output.text !== undefined) {
              batchEntries.push({
                type: "message",
                id: `output-${runId}`,
                role: "assistant",
                text: output.text,
                createdAt: new Date().toISOString(),
                ...(output.continuation
                  ? {
                      continuation: {
                        ...output.continuation,
                        providerId: snapshot.modelRoute.providerId,
                        modelId: snapshot.modelRoute.modelId,
                        modelCallId,
                      },
                      continuationRequired: true,
                      modelCallId,
                    }
                  : {}),
              });
            }

            await this.dependencies.transcripts.appendBatch({
              sessionId: session.sessionId,
              expectedTailSequence: page.entries.at(-1)?.sequence ?? 0,
              entries: batchEntries,
            });

            this.dependencies.events.emit({
              schemaVersion: 1,
              eventName: "attempt.completed",
              occurredAt: new Date().toISOString(),
              sourceModule: "agents",
              agentId,
              sessionKey: session.key,
              sessionId: session.sessionId,
              runId,
              attemptId: control.attemptId,
              payload: { attemptId: control.attemptId },
            });

            if (journalAvailable) {
              try {
                await this.dependencies.journal.append({
                  runId,
                  eventName: "attempt.completed",
                  payload: { attemptId: control.attemptId },
                  occurredAt: new Date().toISOString(),
                });
              } catch {
                journalAvailable = false;
              }
            }

            await control.checkpoint("success");
            break;
          }
        } else {
          await this.executeWithTimeout(controller);
          const page = await this.dependencies.transcripts.readPage(
            session.sessionId,
            { limit: 1_000 },
          );
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
            ],
          });

          this.dependencies.events.emit({
            schemaVersion: 1,
            eventName: "attempt.completed",
            occurredAt: new Date().toISOString(),
            sourceModule: "agents",
            agentId,
            sessionKey: session.key,
            sessionId: session.sessionId,
            runId,
            attemptId: control.attemptId,
            payload: { attemptId: control.attemptId },
          });

          if (journalAvailable) {
            try {
              await this.dependencies.journal.append({
                runId,
                eventName: "attempt.completed",
                payload: { attemptId: control.attemptId },
                occurredAt: new Date().toISOString(),
              });
            } catch {
              journalAvailable = false;
            }
          }

          await control.checkpoint("success");
        }
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
          // A required finalization write failed
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

function isValidGeminiContinuation(
  value: {
    version: string;
    payload: Uint8Array;
    providerId?: string;
    modelId?: string;
    modelCallId?: string;
  },
  expectedRoute: { providerId: string; modelId: string },
): boolean {
  if (
    value.version !== "gemini-thought-signature-v1" ||
    !value.payload.length ||
    value.providerId !== expectedRoute.providerId ||
    value.modelId !== expectedRoute.modelId ||
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
