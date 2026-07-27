import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { InMemorySessionStore } from "../sessions/in-memory-session-store.js";
import { SessionResolver } from "../sessions/session-resolver.js";
import { InMemoryTranscriptStore } from "../sessions/in-memory-transcript-store.js";
import { openDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { SqliteSessionStore } from "../sessions/sqlite-session-store.js";
import { AgentRuntime } from "../agents/agent-runtime.js";
import { SqliteRunJournalStore } from "../agents/run-journal-store.js";
import { SqliteRunStore } from "../agents/run-store.js";
import { RuntimeEventBus } from "../agents/runtime-events.js";
import { SessionRunLaneCoordinator } from "../agents/session-run-lane.js";
import { createGateway, type Gateway } from "./create-gateway.js";

const logger = pino({
  enabled: false,
});

let gateway: Gateway | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe("Gateway WebSocket", () => {
  it("does not cancel an admitted run when its client disconnects", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessions = new SqliteSessionStore(database);
    let release: (() => void) | undefined;
    const runtime = new AgentRuntime({
      sessions: new SessionResolver(sessions),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events: new RuntimeEventBus(),
      lanes: new SessionRunLaneCoordinator(1),
      execute: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    gateway = createGateway({
      host: "127.0.0.1",
      port: 43211,
      logger,
      dependencies: {
        sessions,
        sessionResolver: new SessionResolver(sessions),
        transcripts: new InMemoryTranscriptStore(),
        runtime,
        runs: new SqliteRunStore(database),
        journal: new SqliteRunJournalStore(database),
      },
    });
    await gateway.start();
    const socket = new WebSocket("ws://127.0.0.1:43211/ws");
    const runId = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: 1,
              maxProtocol: 1,
              client: { name: "test", version: "0", mode: "cli" },
            },
          }),
        ),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as {
          id: string;
          ok: boolean;
          payload?: { runId: string };
        };
        if (frame.id === "connect")
          socket.send(
            JSON.stringify({
              type: "req",
              id: "run",
              method: "agent.run",
              params: {
                input: "continue",
                session: { kind: "main", agentId: "primary" },
              },
            }),
          );
        if (frame.id === "run" && frame.ok) {
          socket.close();
          resolve(frame.payload!.runId);
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await new SqliteRunStore(database).get(runId))?.status).toBe(
      "completed",
    );
    database.close();
  });

  it("connects and handles health and sessions RPCs", async () => {
    const sessions = new InMemorySessionStore();

    gateway = createGateway({
      host: "127.0.0.1",
      port: 43210,
      logger,
      dependencies: {
        sessions,
        sessionResolver: new SessionResolver(sessions),
      },
    });

    await gateway.start();

    const socket = new WebSocket("ws://127.0.0.1:43210/ws");

    const frames: unknown[] = [];
    let createdSessionKey: string | undefined;

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-1",
            method: "connect",
            params: {
              minProtocol: 1,
              maxProtocol: 1,
              client: {
                name: "integration-test",
                version: "0.0.0",
                mode: "cli",
              },
            },
          }),
        );
      });

      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as {
          id?: string;
          ok?: boolean;
          payload?: any;
        };

        frames.push(frame);

        if (frame.id === "connect-1" && frame.ok) {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "health-1",
              method: "health",
              params: {},
            }),
          );

          return;
        }

        if (frame.id === "health-1" && frame.ok) {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "session-create-1",
              method: "sessions.create",
              params: {
                key: "agent:primary:test-session",
              },
            }),
          );

          return;
        }

        if (frame.id === "session-create-1" && frame.ok) {
          createdSessionKey = frame.payload.key;

          socket.send(
            JSON.stringify({
              type: "req",
              id: "session-describe-1",
              method: "sessions.describe",
              params: {
                key: createdSessionKey,
              },
            }),
          );

          return;
        }

        if (frame.id === "session-describe-1" && frame.ok) {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "session-resolve-1",
              method: "sessions.resolve",
              params: {
                kind: "main",
                agentId: "primary",
              },
            }),
          );

          return;
        }

        if (frame.id === "session-resolve-1" && frame.ok) {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "session-list-1",
              method: "sessions.list",
              params: {},
            }),
          );

          return;
        }

        if (frame.id === "session-list-1") {
          socket.once("close", resolve);
          socket.close();
        }
      });
    });

    expect(createdSessionKey).toEqual("agent:primary:test-session");

    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "res",
          id: "connect-1",
          ok: true,
        }),

        expect.objectContaining({
          type: "res",
          id: "health-1",
          ok: true,
          payload: expect.objectContaining({
            status: "ok",
            protocol: 1,
          }),
        }),

        expect.objectContaining({
          id: "session-create-1",
          ok: true,
          payload: expect.objectContaining({
            key: "agent:primary:test-session",
            agentId: "primary",
          }),
        }),

        expect.objectContaining({
          id: "session-describe-1",
          ok: true,
          payload: expect.objectContaining({
            key: "agent:primary:test-session",
          }),
        }),

        expect.objectContaining({
          id: "session-resolve-1",
          ok: true,
          payload: expect.objectContaining({
            key: "agent:primary:main",
            agentId: "primary",
          }),
        }),

        expect.objectContaining({
          id: "session-list-1",
          ok: true,
          payload: expect.objectContaining({
            sessions: expect.arrayContaining([
              expect.objectContaining({
                key: "agent:primary:test-session",
              }),
              expect.objectContaining({
                key: "agent:primary:main",
              }),
            ]),
          }),
        }),
      ]),
    );
  });
});
