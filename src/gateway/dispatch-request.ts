import type { Logger } from "pino";
import { toErrorEnvelope } from "../core/errors.js";

import type { GatewayConnection } from "./connection.js";
import { gatewayMethodHandlers } from "./methods/registry.js";
import type { GatewayMethodDependencies } from "./methods/types.js";
import type { RequestFrame, ResponseFrame } from "./protocol/schema/frames.js";
import {
  isGatewayMethod,
  validateMethodParams,
} from "./protocol/validate-method.js";

export type DispatchRequestOptions = {
  connection: GatewayConnection;
  request: RequestFrame;
  logger: Logger;
  dependencies: GatewayMethodDependencies;
};

export async function dispatchRequest(
  options: DispatchRequestOptions,
): Promise<ResponseFrame> {
  const { connection, request, logger, dependencies } = options;

  if (!isGatewayMethod(request.method)) {
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "method_not_found",
        message: `Unknown method: ${request.method}`,
      },
    };
  }

  if (
    connection.state.status === "connecting" &&
    request.method !== "connect"
  ) {
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "not_connected",
        message: "The first request must be connect",
      },
    };
  }

  if (connection.state.status === "ready" && request.method === "connect") {
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "already_connected",
        message: "Client is already connected",
      },
    };
  }

  const validation = validateMethodParams(request.method, request.params);

  if (!validation.ok) {
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "invalid_params",
        message: `Invalid params for ${request.method}`,
        details: validation.errors,
      },
    };
  }

  try {
    return await gatewayMethodHandlers[request.method]({
      connection,
      request: {
        ...request,
        params: validation.params,
      },
      logger,
      dependencies,
    });
  } catch (error: unknown) {
    const normalized = toErrorEnvelope(error);
    return { type: "res", id: request.id, ok: false, error: normalized };
  }
}
