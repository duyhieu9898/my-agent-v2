import type { Logger } from "pino";

import type { SessionResolver } from "../../sessions/session-resolver.js";
import type { SessionStore } from "../../sessions/session-store.js";
import type { TranscriptStore } from "../../sessions/transcript-store.js";
import type { AgentRuntime } from "../../agents/agent-runtime.js";
import type { RunStore } from "../../agents/run-store.js";
import type { RunJournalStore } from "../../agents/run-journal-store.js";
import type { RuntimeEventBus } from "../../agents/runtime-events.js";
import type { GatewayConnection } from "../connection.js";
import type { RequestFrame, ResponseFrame } from "../protocol/schema/frames.js";

import type { UsageBudgetGate } from "../../usage/usage-budget-gate.js";
import type { ApprovalCoordinator } from "../../policy/approval-coordinator.js";

export type GatewayMethodDependencies = {
  sessions: SessionStore;
  sessionResolver: SessionResolver;
  transcripts?: TranscriptStore;
  runtime?: AgentRuntime;
  runs?: RunStore;
  journal?: RunJournalStore;
  events?: RuntimeEventBus;
  usageBudgetGate?: UsageBudgetGate;
  approvalCoordinator?: ApprovalCoordinator;
};

export type GatewayMethodContext = {
  connection: GatewayConnection;
  request: RequestFrame;
  logger: Logger;
  dependencies: GatewayMethodDependencies;
};

export type GatewayMethodHandler = (
  context: GatewayMethodContext,
) => ResponseFrame | Promise<ResponseFrame>;
