import pino from "pino";
import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../sessions/in-memory-session-store.js";
import { InMemoryTranscriptStore } from "../sessions/in-memory-transcript-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { AgentRuntime } from "../agents/agent-runtime.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
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

  it("validates agent.run parameters before touching runtime dependencies", async () => {
    const connection: GatewayConnection = {
      socket: {} as GatewayConnection["socket"],
      state: {
        status: "ready",
        protocol: 1,
        client: { name: "test", version: "0", mode: "cli" },
      },
    };
    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "run-invalid",
        method: "agent.run",
        params: { input: "" },
      },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("normalizes application handler errors into response frames", async () => {
    const connection: GatewayConnection = {
      socket: {} as GatewayConnection["socket"],
      state: {
        status: "ready",
        protocol: 1,
        client: { name: "test", version: "0", mode: "cli" },
      },
    };
    const response = await dispatchRequest({
      connection,
      logger,
      dependencies,
      request: {
        type: "req",
        id: "run-get",
        method: "run.get",
        params: { runId: "missing-runtime" },
      },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
  });

  it("dispatches the admitted-run read path through thin Gateway handlers", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessionStore = new SqliteSessionStore(database);
    const resolver = new SessionResolver(sessionStore);
    const transcripts = new InMemoryTranscriptStore();
    const runs = new SqliteRunStore(database);
    const journal = new SqliteRunJournalStore(database);
    const runtime = new AgentRuntime({
      sessions: resolver,
      transcripts,
      runs,
      journal,
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(2),
    });
    const connection: GatewayConnection = {
      socket: {} as GatewayConnection["socket"],
      state: {
        status: "ready",
        protocol: 1,
        client: { name: "test", version: "0", mode: "cli" },
      },
    };
    const response = await dispatchRequest({
      connection,
      logger,
      dependencies: {
        sessions: sessionStore,
        sessionResolver: resolver,
        transcripts,
        runtime,
        runs,
        journal,
      },
      request: {
        type: "req",
        id: "run",
        method: "agent.run",
        params: {
          input: "Hello",
          session: { kind: "main", agentId: "primary" },
        },
      },
    });
    expect(response).toMatchObject({
      ok: true,
      payload: { runId: expect.any(String) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    database.close();
  });
});
