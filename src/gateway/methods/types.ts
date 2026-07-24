import type { Logger } from "pino";

import type { SessionResolver } from "../../sessions/session-resolver.js";
import type { SessionStore } from "../../sessions/session-store.js";
import type { GatewayConnection } from "../connection.js";
import type {
  RequestFrame,
  ResponseFrame,
} from "../protocol/schema/frames.js";

export type GatewayMethodDependencies = {
  sessions: SessionStore;
  sessionResolver: SessionResolver;
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