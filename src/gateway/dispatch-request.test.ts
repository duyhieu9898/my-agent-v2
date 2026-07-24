import pino from "pino";
import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../sessions/in-memory-session-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import type { GatewayConnection } from "./connection.js";
import { dispatchRequest } from "./dispatch-request.js";

const logger = pino({
  enabled: false,
});

const sessions = new InMemorySessionStore();

const dependencies = {
  sessions,
  sessionResolver: new SessionResolver(sessions),
};

function createConnection(): GatewayConnection {
  return {
    socket: {} as GatewayConnection["socket"],
    state: {
      status: "connecting",
    },
  };
}

describe("dispatchRequest", () => {
  it("requires connect as the first request", async () => {
    const connection = createConnection();

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-1",
        method: "health",
        params: {},
      },
    });

    expect(response).toMatchObject({
      type: "res",
      id: "req-1",
      ok: false,
      error: {
        code: "not_connected",
      },
    });
  });

  it("connects a compatible client", async () => {
    const connection = createConnection();

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-connect",
        method: "connect",
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test-client",
            version: "0.0.0",
            mode: "cli",
          },
        },
      },
    });

    expect(response).toMatchObject({
      type: "res",
      id: "req-connect",
      ok: true,
    });

    expect(connection.state).toMatchObject({
      status: "ready",
      protocol: 1,
    });
  });

  it("rejects a second connect request", async () => {
    const connection: GatewayConnection = {
      socket: {} as GatewayConnection["socket"],
      state: {
        status: "ready",
        protocol: 1,
        client: {
          name: "test-client",
          version: "0.0.0",
          mode: "cli",
        },
      },
    };

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-connect-2",
        method: "connect",
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test-client",
            version: "0.0.0",
            mode: "cli",
          },
        },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "already_connected",
      },
    });
  });

  it("rejects an unsupported protocol", async () => {
    const connection = createConnection();

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-connect",
        method: "connect",
        params: {
          minProtocol: 2,
          maxProtocol: 2,
          client: {
            name: "test-client",
            version: "0.0.0",
            mode: "cli",
          },
        },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_protocol",
      },
    });
  });

  it("returns health after connection", async () => {
    const connection: GatewayConnection = {
      socket: {} as GatewayConnection["socket"],
      state: {
        status: "ready",
        protocol: 1,
        client: {
          name: "test-client",
          version: "0.0.0",
          mode: "cli",
        },
      },
    };

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-health",
        method: "health",
        params: {},
      },
    });

    expect(response).toMatchObject({
      type: "res",
      id: "req-health",
      ok: true,
      payload: {
        status: "ok",
        protocol: 1,
      },
    });
  });

  it("rejects an unknown method", async () => {
    const connection = createConnection();

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-unknown",
        method: "unknown.method",
        params: {},
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "method_not_found",
      },
    });
  });

  it("rejects invalid connect params", async () => {
    const connection = createConnection();

    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "req-connect",
        method: "connect",
        params: {
          minProtocol: 1,
        },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
      },
    });
  });
});