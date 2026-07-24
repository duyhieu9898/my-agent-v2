import {
  ConnectParamsSchema,
  ConnectResultSchema,
} from "./connect.js";
import {
  HealthParamsSchema,
  HealthResultSchema,
} from "./health.js";
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
} as const;

export type GatewayMethod = keyof typeof GatewayMethods;