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
import { createRuntimeAuthority } from "../test/foundation-fixtures.js";
import { createGateway, type Gateway } from "./create-gateway.js";

const logger = pino({
  enabled: false,
});

let gateway: Gateway | undefined;

type ReceivedFrame = Record<string, unknown>;

function collectFrames(socket: WebSocket): {
  frames: readonly ReceivedFrame[];
  waitFor(predicate: (frame: ReceivedFrame) => boolean): Promise<ReceivedFrame>;
} {
  const frames: ReceivedFrame[] = [];
  const waiters: Array<{
    predicate: (frame: ReceivedFrame) => boolean;
    resolve(frame: ReceivedFrame): void;
  }> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as ReceivedFrame;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  return {
    frames,
    async waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return existing;
      return new Promise<ReceivedFrame>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
}

async function connectClient(port: number): Promise<{
  socket: WebSocket;
  frames: ReturnType<typeof collectFrames>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = collectFrames(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", resolve);
  });
  socket.send(
    JSON.stringify({
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "integration-test", version: "0", mode: "cli" },
      },
    }),
  );
  await frames.waitFor((frame) => frame.id === "connect" && frame.ok === true);
  return { socket, frames };
}

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe("Gateway WebSocket", () => {
  it("sends admission before exactly one owner-scoped completed terminal event", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessions = new SqliteSessionStore(database);
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(sessions),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    gateway = createGateway({
      host: "127.0.0.1",
      port: 43212,
      logger,
      dependencies: {
        sessions,
        sessionResolver: new SessionResolver(sessions),
        runtime,
        runs: new SqliteRunStore(database),
        journal: new SqliteRunJournalStore(database),
        events,
      },
    });
    await gateway.start();
    const owner = await connectClient(43212);
    const observer = await connectClient(43212);
    owner.socket.send(
      JSON.stringify({
        type: "req",
        id: "run",
        method: "agent.run",
        params: {
          input: "hello",
          session: { kind: "main", agentId: "primary" },
        },
      }),
    );
    const admission = await owner.frames.waitFor(
      (frame) => frame.id === "run" && frame.ok === true,
    );
    const runId = (admission.payload as { runId: string }).runId;
    const terminal = await owner.frames.waitFor(
      (frame) =>
        frame.type === "event" &&
        frame.event === "run.completed" &&
        (frame.payload as { runId?: string }).runId === runId,
    );
    expect(owner.frames.frames.indexOf(admission)).toBeLessThan(
      owner.frames.frames.indexOf(terminal),
    );
    expect(
      owner.frames.frames.filter(
        (frame) =>
          frame.type === "event" &&
          frame.event === "run.completed" &&
          (frame.payload as { runId?: string }).runId === runId,
      ),
    ).toHaveLength(1);
    expect(
      observer.frames.frames.some(
        (frame) =>
          frame.type === "event" &&
          (frame.payload as { runId?: string }).runId === runId,
      ),
    ).toBe(false);
    expect((await new SqliteRunStore(database).get(runId))?.status).toBe(
      "completed",
    );
    expect(
      (await new SqliteRunJournalStore(database).readPage(runId)).entries.some(
        (entry) => entry.eventName === "finalize.completed",
      ),
    ).toBe(true);
    owner.socket.close();
    observer.socket.close();
    database.close();
  });

  it("publishes one normalized failed terminal event after durable failure", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessions = new SqliteSessionStore(database);
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(sessions),
      transcripts: {
        readPage: async () => ({ entries: [] }),
        readContinuation: async () => undefined,
        appendBatch: async () => {
          throw new Error("SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE");
        },
      },
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
    });
    gateway = createGateway({
      host: "127.0.0.1",
      port: 43213,
      logger,
      dependencies: {
        sessions,
        sessionResolver: new SessionResolver(sessions),
        runtime,
        runs: new SqliteRunStore(database),
        journal: new SqliteRunJournalStore(database),
        events,
      },
    });
    await gateway.start();
    const client = await connectClient(43213);
    client.socket.send(
      JSON.stringify({
        type: "req",
        id: "run",
        method: "agent.run",
        params: {
          input: "hello",
          session: { kind: "main", agentId: "primary" },
        },
      }),
    );
    const admission = await client.frames.waitFor(
      (frame) => frame.id === "run" && frame.ok === true,
    );
    const runId = (admission.payload as { runId: string }).runId;
    const terminal = await client.frames.waitFor(
      (frame) =>
        frame.type === "event" &&
        frame.event === "run.failed" &&
        (frame.payload as { runId?: string }).runId === runId,
    );
    expect(JSON.stringify(terminal)).not.toContain(
      "SUPER_SECRET_THOUGHT_SIGNATURE_DO_NOT_EXPOSE",
    );
    expect(
      client.frames.frames.filter(
        (frame) =>
          frame.type === "event" &&
          frame.event === "run.failed" &&
          (frame.payload as { runId?: string }).runId === runId,
      ),
    ).toHaveLength(1);
    expect((await new SqliteRunStore(database).get(runId))?.status).toBe(
      "failed",
    );
    client.socket.close();
    database.close();
  });

  it("publishes one cancelled terminal event through run.cancel", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessions = new SqliteSessionStore(database);
    const events = new RuntimeEventBus();
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(sessions),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
      lanes: new SessionRunLaneCoordinator(1),
      execute: (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    });
    gateway = createGateway({
      host: "127.0.0.1",
      port: 43214,
      logger,
      dependencies: {
        sessions,
        sessionResolver: new SessionResolver(sessions),
        runtime,
        runs: new SqliteRunStore(database),
        journal: new SqliteRunJournalStore(database),
        events,
      },
    });
    await gateway.start();
    const client = await connectClient(43214);
    client.socket.send(
      JSON.stringify({
        type: "req",
        id: "run",
        method: "agent.run",
        params: {
          input: "hello",
          session: { kind: "main", agentId: "primary" },
        },
      }),
    );
    const admission = await client.frames.waitFor(
      (frame) => frame.id === "run" && frame.ok === true,
    );
    const runId = (admission.payload as { runId: string }).runId;
    client.socket.send(
      JSON.stringify({
        type: "req",
        id: "cancel",
        method: "run.cancel",
        params: { runId },
      }),
    );
    await client.frames.waitFor(
      (frame) => frame.id === "cancel" && frame.ok === true,
    );
    await client.frames.waitFor(
      (frame) =>
        frame.type === "event" &&
        frame.event === "run.cancelled" &&
        (frame.payload as { runId?: string }).runId === runId,
    );
    expect(
      client.frames.frames.filter(
        (frame) =>
          frame.type === "event" &&
          frame.event === "run.cancelled" &&
          (frame.payload as { runId?: string }).runId === runId,
      ),
    ).toHaveLength(1);
    expect((await new SqliteRunStore(database).get(runId))?.status).toBe(
      "cancelled",
    );
    client.socket.close();
    database.close();
  });

  it("does not cancel an admitted run when its client disconnects", async () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const sessions = new SqliteSessionStore(database);
    const events = new RuntimeEventBus();
    let resolveTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    let release: (() => void) | undefined;
    const runtime = new AgentRuntime({
      ...createRuntimeAuthority(),
      sessions: new SessionResolver(sessions),
      transcripts: new InMemoryTranscriptStore(),
      runs: new SqliteRunStore(database),
      journal: new SqliteRunJournalStore(database),
      events,
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
        events,
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
    events.subscribe((event) => {
      if (event.runId === runId && event.eventName === "run.completed")
        resolveTerminal?.();
    });
    release?.();
    await terminal;
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
