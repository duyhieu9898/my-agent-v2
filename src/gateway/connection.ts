import type { WebSocket } from "ws";

export type GatewayConnectionState =
  | {
      status: "connecting";
    }
  | {
      status: "ready";
      protocol: number;
      client: {
        name: string;
        version: string;
        mode: "web" | "cli";
      };
    };

export type GatewayConnection = {
  socket: WebSocket;
  state: GatewayConnectionState;
};
