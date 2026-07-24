import { GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import type { ConnectParams } from "../protocol/schema/connect.js";
import type { GatewayMethodHandler } from "./types.js";

export const handleConnect: GatewayMethodHandler = ({
  connection,
  request,
  logger,
}) => {
  const params = request.params as ConnectParams;

  if (
    params.minProtocol > GATEWAY_PROTOCOL_VERSION ||
    params.maxProtocol < GATEWAY_PROTOCOL_VERSION
  ) {
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "unsupported_protocol",
        message: "No compatible Gateway protocol version",
      },
    };
  }

  connection.state = {
    status: "ready",
    protocol: GATEWAY_PROTOCOL_VERSION,
    client: params.client,
  };

  logger.info(
    {
      client: params.client,
      protocol: GATEWAY_PROTOCOL_VERSION,
    },
    "gateway client ready",
  );

  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: {
      protocol: GATEWAY_PROTOCOL_VERSION,
      gateway: {
        name: "my-agent",
        version: "0.0.0",
      },
    },
  };
};