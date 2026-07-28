import type { GatewayMethod } from "../protocol/schema/methods.js";
import { handleConnect } from "./connect.js";
import { handleHealth } from "./health.js";
import {
  handleSessionsCreate,
  handleSessionsDescribe,
  handleSessionsList,
  handleSessionsResolve,
} from "./sessions.js";
import type { GatewayMethodHandler } from "./types.js";
import {
  handleAgentRun,
  handleRunCancel,
  handleRunGet,
  handleRunJournal,
  handleRunUsage,
  handleSessionHistory,
} from "./runs.js";

export const gatewayMethodHandlers: Record<
  GatewayMethod,
  GatewayMethodHandler
> = {
  connect: handleConnect,
  health: handleHealth,
  "sessions.create": handleSessionsCreate,
  "sessions.describe": handleSessionsDescribe,
  "sessions.resolve": handleSessionsResolve,
  "sessions.list": handleSessionsList,
  "agent.run": handleAgentRun,
  "run.get": handleRunGet,
  "run.cancel": handleRunCancel,
  "session.history": handleSessionHistory,
  "run.journal": handleRunJournal,
  "run.usage": handleRunUsage,
};
