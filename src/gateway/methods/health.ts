import { GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import type { GatewayMethodHandler } from "./types.js";

export const handleHealth: GatewayMethodHandler = ({ request }) => ({
  type: "res",
  id: request.id,
  ok: true,
  payload: {
    status: "ok",
    uptimeMs: Math.floor(process.uptime() * 1000),
    protocol: GATEWAY_PROTOCOL_VERSION,
  },
});
