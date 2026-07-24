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
};