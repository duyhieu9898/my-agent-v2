import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { AppConfig } from "../config/config.schema.js";
import { createApp, type App } from "../bootstrap/create-app.js";
import type { InteractionsClient } from "../models/gemini-interactions-provider.js";

function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "verifier-"));
  return {
    path: join(dir, "agent.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function verifierConfig(path: string): AppConfig {
  return {
    nodeEnv: "test",
    logLevel: "info",
    dataDir: "./data",
    workspaceDir: "./workspace",
    database: { path },
    gateway: { host: "127.0.0.1", port: 0 },
    runtime: {
      perSessionQueueCapacity: 4,
      maxConcurrentModelCalls: 2,
      runTimeoutMs: 60_000,
    },
    agent: {
      defaultId: "primary",
      model: {
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        geminiApiKeyEnvironmentVariable: "GEMINI_API_KEY",
        contextTokenBudget: 12000,
      },
    },
    usage: {
      captureProfile: "production",
      maxOutputTokens: 8_192,
      thinkingTokens: 0,
      reservationSafetyMarginTokens: 256,
      priceCatalog: [
        {
          revision: "price-v1",
          effectiveFrom: "2000-01-01T00:00:00.000Z",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          inputMicrosPerMillionTokens: 1_000_000n,
          outputMicrosPerMillionTokens: 2_000_000n,
        },
      ],
      capPolicies: [
        {
          id: "default-daily-cap",
          revision: "rev-1",
          window: "day",
          maxTokens: 1_000_000n,
          enabled: true,
          ruleMetadata: { rule: "daily-budget-safety" },
        },
      ],
    },
  };
}

type ReceivedFrame = Record<string, unknown>;

function collectFrames(socket: WebSocket): {
  frames: readonly ReceivedFrame[];
  waitFor(
    predicate: (frame: ReceivedFrame) => boolean,
    timeoutMs?: number,
  ): Promise<ReceivedFrame>;
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
    async waitFor(predicate, timeoutMs = 10_000) {
      const existing = frames.find(predicate);
      if (existing) return existing;
      return new Promise<ReceivedFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`Timeout waiting for predicate after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
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
        client: { name: "verifier-test", version: "1.0", mode: "cli" },
      },
    }),
  );
  await frames.waitFor((frame) => frame.id === "connect" && frame.ok === true);
  return { socket, frames };
}

describe("Supported API Verifier", () => {
  it("executes complete run, streams non-terminal/terminal events, retrieves state & usage metadata via Gateway RPC without direct SQL, and reopens for turn 2 continuation", async () => {
    const db = tempDbPath();

    const fakeResponder = (promptText: string, interactionId: string) => ({
      output_text: `Response to ${promptText}`,
      id: interactionId,
      usage: {
        total_tokens: 50,
        total_input_tokens: 20,
        total_output_tokens: 30,
      },
      steps: [{ type: "thought", signature: `thought-sig-${interactionId}` }],
    });

    let callCount = 0;
    const fakeGeminiClient: InteractionsClient = {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          callCount++;
          const input = params.input as
            Array<{ content?: Array<{ text?: string }> }> | undefined;
          const text = input?.[0]?.content?.[0]?.text ?? "prompt";
          return fakeResponder(text, `int-${callCount}`);
        },
      },
    } as never;

    // --- PHASE 1: First Cycle over Gateway WebSocket ---
    const app1 = createApp(verifierConfig(db.path), {
      geminiClient: fakeGeminiClient,
    });
    await app1.start();
    const port1 = app1.gateway.port;

    const { socket: socket1, frames: frames1 } = await connectClient(port1);

    // Resolve session identity
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "resolve-sess-1",
        method: "sessions.resolve",
        params: { kind: "main", agentId: "primary" },
      }),
    );
    const sessRes1 = await frames1.waitFor((f) => f.id === "resolve-sess-1");
    expect(sessRes1.ok).toBe(true);
    const sessionId = (sessRes1.payload as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();

    // Send agent.run
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "run-turn-1",
        method: "agent.run",
        params: {
          session: { kind: "main", agentId: "primary" },
          input: "Turn 1 prompt",
        },
      }),
    );

    const runRes = await frames1.waitFor(
      (f) => f.id === "run-turn-1" && f.ok === true,
    );
    const runId1 = (runRes.payload as { runId: string }).runId;
    expect(runId1).toBeTruthy();

    // Wait for terminal run.completed event
    await frames1.waitFor(
      (f) =>
        f.type === "event" &&
        f.event === "run.completed" &&
        (f.payload as { runId?: string })?.runId === runId1,
    );

    // Filter event stream for runId1
    const run1Events = frames1.frames
      .filter(
        (f) =>
          f.type === "event" &&
          (f.payload as { runId?: string })?.runId === runId1,
      )
      .map((f) => f.event as string);

    // Verify non-terminal and terminal event order
    expect(run1Events).toContain("run.queued");
    expect(run1Events).toContain("run.started");
    expect(run1Events).toContain("attempt.started");
    expect(run1Events).toContain("stage.started");
    expect(run1Events).toContain("context.prepared");
    expect(run1Events).toContain("model.requested");
    expect(run1Events).toContain("model.completed");
    expect(run1Events).toContain("stage.completed");
    expect(run1Events).toContain("attempt.completed");
    expect(run1Events).toContain("finalize.started");
    expect(run1Events).toContain("run.completed");

    // RPC: run.get
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "get-1",
        method: "run.get",
        params: { runId: runId1 },
      }),
    );
    const getRes1 = await frames1.waitFor((f) => f.id === "get-1");
    expect(getRes1.ok).toBe(true);
    expect((getRes1.payload as { status: string }).status).toBe("completed");

    // RPC: session.history
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "history-1",
        method: "session.history",
        params: { sessionId },
      }),
    );
    const historyRes1 = await frames1.waitFor((f) => f.id === "history-1");
    expect(historyRes1.ok).toBe(true);
    const entries1 = (
      historyRes1.payload as { entries: Array<{ role: string; text?: string }> }
    ).entries;
    expect(
      entries1.some((e) => e.role === "user" && e.text === "Turn 1 prompt"),
    ).toBe(true);
    expect(
      entries1.some(
        (e) => e.role === "assistant" && e.text === "Response to Turn 1 prompt",
      ),
    ).toBe(true);

    // RPC: run.journal
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "journal-1",
        method: "run.journal",
        params: { runId: runId1 },
      }),
    );
    const journalRes1 = await frames1.waitFor((f) => f.id === "journal-1");
    expect(journalRes1.ok).toBe(true);
    const journalEntries1 = (
      journalRes1.payload as { entries: Array<{ eventName: string }> }
    ).entries.map((e) => e.eventName);
    expect(journalEntries1).toContain("run.accepted");
    expect(journalEntries1).toContain("attempt.started");
    expect(journalEntries1).toContain("stage.started");
    expect(journalEntries1).toContain("context.prepared");
    expect(journalEntries1).toContain("model.requested");
    expect(journalEntries1).toContain("model.completed");
    expect(journalEntries1).toContain("model.continuation.persisted");
    expect(journalEntries1).toContain("usage.settled");
    expect(journalEntries1).toContain("stage.completed");
    expect(journalEntries1).toContain("attempt.completed");
    expect(journalEntries1).toContain("finalize.started");
    expect(journalEntries1).toContain("run.completed");

    // RPC: run.usage
    socket1.send(
      JSON.stringify({
        type: "req",
        id: "usage-1",
        method: "run.usage",
        params: { runId: runId1 },
      }),
    );
    const usageRes1 = await frames1.waitFor((f) => f.id === "usage-1");
    expect(usageRes1.ok).toBe(true);
    const usagePayload1 = usageRes1.payload as {
      reservations: Array<{
        usageReservationId: string;
        matchedPolicyIds: string[];
        policyRevision: string;
        ruleMetadata: Record<string, unknown>;
      }>;
      records: Array<{
        usageRecordId: string;
        matchedPolicyIds: string[];
        policyRevision: string;
        ruleMetadata: Record<string, unknown>;
      }>;
    };
    expect(usagePayload1.reservations.length).toBeGreaterThan(0);
    expect(usagePayload1.records.length).toBeGreaterThan(0);
    expect(usagePayload1.reservations[0]!.matchedPolicyIds).toContain(
      "default-daily-cap",
    );
    expect(usagePayload1.reservations[0]!.ruleMetadata).toEqual({
      rule: "daily-budget-safety",
    });
    expect(usagePayload1.records[0]!.matchedPolicyIds).toContain(
      "default-daily-cap",
    );

    socket1.close();
    await app1.stop();

    // --- PHASE 2: Reopen Application & Second Turn over Gateway ---
    const app2 = createApp(verifierConfig(db.path), {
      geminiClient: fakeGeminiClient,
    });
    await app2.start();
    const port2 = app2.gateway.port;

    const { socket: socket2, frames: frames2 } = await connectClient(port2);

    // Retrieve state across restart via supported Gateway RPCs without direct SQL
    socket2.send(
      JSON.stringify({
        type: "req",
        id: "restart-history",
        method: "session.history",
        params: { sessionId },
      }),
    );
    const restartHistoryRes = await frames2.waitFor(
      (f) => f.id === "restart-history",
    );
    expect(restartHistoryRes.ok).toBe(true);

    socket2.send(
      JSON.stringify({
        type: "req",
        id: "restart-usage",
        method: "run.usage",
        params: { runId: runId1 },
      }),
    );
    const restartUsageRes = await frames2.waitFor(
      (f) => f.id === "restart-usage",
    );
    expect(restartUsageRes.ok).toBe(true);
    const restartUsagePayload = restartUsageRes.payload as {
      reservations: Array<{ matchedPolicyIds: string[] }>;
    };
    expect(restartUsagePayload.reservations[0]!.matchedPolicyIds).toContain(
      "default-daily-cap",
    );

    // Second prompt continuation turn
    socket2.send(
      JSON.stringify({
        type: "req",
        id: "run-turn-2",
        method: "agent.run",
        params: {
          session: { kind: "main", agentId: "primary" },
          input: "Turn 2 prompt",
        },
      }),
    );

    const runRes2 = await frames2.waitFor(
      (f) => f.id === "run-turn-2" && f.ok === true,
    );
    const runId2 = (runRes2.payload as { runId: string }).runId;

    await frames2.waitFor(
      (f) =>
        f.type === "event" &&
        f.event === "run.completed" &&
        (f.payload as { runId?: string })?.runId === runId2,
    );

    // RPC: session.history after turn 2
    socket2.send(
      JSON.stringify({
        type: "req",
        id: "history-2",
        method: "session.history",
        params: { sessionId },
      }),
    );
    const historyRes2 = await frames2.waitFor((f) => f.id === "history-2");
    expect(historyRes2.ok).toBe(true);
    const entries2 = (
      historyRes2.payload as { entries: Array<{ role: string; text?: string }> }
    ).entries;
    expect(entries2.filter((e) => e.role === "user")).toHaveLength(2);
    expect(entries2.filter((e) => e.role === "assistant")).toHaveLength(2);

    socket2.close();
    await app2.stop();
    db.cleanup();
  });
});
