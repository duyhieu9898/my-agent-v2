import { ConnectParamsSchema, ConnectResultSchema } from "./connect.js";
import { HealthParamsSchema, HealthResultSchema } from "./health.js";
import {
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsDescribeParamsSchema,
  SessionsDescribeResultSchema,
  SessionsListParamsSchema,
  SessionsListResultSchema,
  SessionsResolveParamsSchema,
  SessionsResolveResultSchema,
} from "./sessions.js";
import {
  AgentRunParamsSchema,
  AgentRunResultSchema,
  AnyResultSchema,
  RunGetParamsSchema,
  RunCancelParamsSchema,
  RunJournalParamsSchema,
  RunUsageParamsSchema,
  SessionHistoryParamsSchema,
} from "./runs.js";

export const GatewayMethods = {
  connect: {
    params: ConnectParamsSchema,
    result: ConnectResultSchema,
  },

  health: {
    params: HealthParamsSchema,
    result: HealthResultSchema,
  },

  "sessions.create": {
    params: SessionsCreateParamsSchema,
    result: SessionsCreateResultSchema,
  },

  "sessions.describe": {
    params: SessionsDescribeParamsSchema,
    result: SessionsDescribeResultSchema,
  },

  "sessions.resolve": {
    params: SessionsResolveParamsSchema,
    result: SessionsResolveResultSchema,
  },

  "sessions.list": {
    params: SessionsListParamsSchema,
    result: SessionsListResultSchema,
  },
  "agent.run": { params: AgentRunParamsSchema, result: AgentRunResultSchema },
  "run.get": { params: RunGetParamsSchema, result: AnyResultSchema },
  "run.cancel": { params: RunCancelParamsSchema, result: AnyResultSchema },
  "session.history": {
    params: SessionHistoryParamsSchema,
    result: AnyResultSchema,
  },
  "run.journal": { params: RunJournalParamsSchema, result: AnyResultSchema },
  "run.usage": { params: RunUsageParamsSchema, result: AnyResultSchema },
} as const;

export type GatewayMethod = keyof typeof GatewayMethods;
