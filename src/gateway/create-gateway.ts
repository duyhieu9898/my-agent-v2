import { createServer, type Server } from "node:http";

import type { Logger } from "pino";
import { WebSocketServer, type WebSocket } from "ws";

import { validateGatewayFrame } from "./protocol/validate-frame.js";
import type { GatewayConnection } from "./connection.js";
import { dispatchRequest } from "./dispatch-request.js";
import type { GatewayMethodDependencies } from "./methods/types.js";

export type GatewayOptions = {
  host: string;
  port: number;
  logger: Logger;
  dependencies: GatewayMethodDependencies;
};

export type Gateway = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createGateway(options: GatewayOptions): Gateway {
  const { host, port, logger, dependencies } = options;

  let server: Server | undefined;
  let webSocketServer: WebSocketServer | undefined;

  return {
    async start(): Promise<void> {
      if (server) {
        throw new Error("Gateway is already started");
      }

      const newServer = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/healthz") {
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });

          response.end(JSON.stringify({ status: "ok" }));
          return;
        }

        response.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
        });

        response.end(JSON.stringify({ error: "not_found" }));
      });

      const newWebSocketServer = new WebSocketServer({
        noServer: true,
      });

      newServer.on("upgrade", (request, socket, head) => {
        if (request.url !== "/ws") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }

        newWebSocketServer.handleUpgrade(
          request,
          socket,
          head,
          (webSocket) => {
            newWebSocketServer.emit(
              "connection",
              webSocket,
              request,
            );
          },
        );
      });

      newWebSocketServer.on(
        "connection",
        (webSocket: WebSocket) => {
          logger.info("gateway client connected");

          const connection: GatewayConnection = {
            socket: webSocket,
            state: {
              status: "connecting",
            },
          };

          webSocket.on("message", async (data) => {
            let value: unknown;

            try {
              value = JSON.parse(data.toString());
            } catch {
              webSocket.send(
                JSON.stringify({
                  type: "res",
                  id: "",
                  ok: false,
                  error: {
                    code: "invalid_json",
                    message: "Message must be valid JSON",
                  },
                }),
              );

              return;
            }

            const result = validateGatewayFrame(value);

            if (!result.ok) {
              webSocket.send(
                JSON.stringify({
                  type: "res",
                  id:
                    typeof value === "object" &&
                    value !== null &&
                    "id" in value &&
                    typeof value.id === "string"
                      ? value.id
                      : "",
                  ok: false,
                  error: {
                    code: "invalid_frame",
                    message: "Invalid Gateway frame",
                    details: result.errors,
                  },
                }),
              );

              return;
            }

            if (result.frame.type !== "req") {
              webSocket.send(
                JSON.stringify({
                  type: "res",
                  id: "id" in result.frame ? result.frame.id : "",
                  ok: false,
                  error: {
                    code: "unexpected_frame",
                    message: "Clients may only send request frames",
                  },
                }),
              );

              return;
            }

            const response = await dispatchRequest({
              connection,
              request: result.frame,
              logger,
              dependencies,
            });

            webSocket.send(JSON.stringify(response));
          });

          webSocket.on("close", () => {
            logger.info("gateway client disconnected");
          });

          webSocket.on("error", (error) => {
            logger.warn(
              { error },
              "gateway client socket error",
            );
          });
        },
      );

      await new Promise<void>((resolve, reject) => {
        newServer.once("error", reject);

        newServer.listen(port, host, () => {
          newServer.off("error", reject);
          resolve();
        });
      });

      server = newServer;
      webSocketServer = newWebSocketServer;

      logger.info(
        {
          host,
          port,
          websocketPath: "/ws",
        },
        "gateway started",
      );
    },

    async stop(): Promise<void> {
      const currentServer = server;
      const currentWebSocketServer = webSocketServer;

      server = undefined;
      webSocketServer = undefined;

      if (currentWebSocketServer) {
        for (const client of currentWebSocketServer.clients) {
          client.close(1001, "Gateway shutting down");
        }

        currentWebSocketServer.close();
      }

      if (currentServer) {
        await new Promise<void>((resolve, reject) => {
          currentServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      }

      logger.info("gateway stopped");
    },
  };
}