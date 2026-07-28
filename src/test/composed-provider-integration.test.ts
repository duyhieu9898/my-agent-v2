import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config/config.schema.js";
import { createApp, type App } from "../bootstrap/create-app.js";
import type { InteractionsClient } from "../models/gemini-interactions-provider.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";

function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "composed-"));
  return {
    path: join(dir, "agent.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function baseConfig(path: string): AppConfig {
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
      capPolicies: [],
    },
  };
}

type CapturedRequest = {
  model?: string;
  store?: boolean;
  previous_interaction_id?: unknown;
  system_instruction?: string;
  input?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
};

function fakeClient(
  responder: (request: CapturedRequest) => unknown,
  sink: CapturedRequest[],
): InteractionsClient {
  return {
    interactions: {
      create: async (params: CapturedRequest) => {
        sink.push(params);
        return responder(params);
      },
    },
  } as never;
}

async function waitForRunStatus(
  reader: AppDatabase,
  runId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const row = reader
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(runId) as { status: string } | undefined;
    if (
      row &&
      (row.status === "completed" ||
        row.status === "failed" ||
        row.status === "cancelled")
    )
      return row.status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`run ${runId} did not terminate`);
}

function narrowConfig(path: string): AppConfig {
  const base = baseConfig(path);
  return {
    ...base,
    runtime: { ...base.runtime, perSessionQueueCapacity: 1 },
  };
}

function firstCycleResponder(): (request: CapturedRequest) => unknown {
  return () => ({
    output_text: "first answer",
    id: "interaction-1",
    usage: {
      total_tokens: 30,
      total_input_tokens: 10,
      total_output_tokens: 20,
    },
    steps: [{ type: "thought", signature: "composed-first-signature" }],
  });
}

function secondCycleResponder(): (request: CapturedRequest) => unknown {
  // Never reached on the negative paths: the continuation incompatibility is
  // detected from local SQLite before any provider dispatch. Kept realistic so
  // a regression that bypassed the local check would surface as a wrong outcome.
  return () => ({
    output_text: "second answer",
    id: "interaction-2",
    usage: {
      total_tokens: 24,
      total_input_tokens: 12,
      total_output_tokens: 12,
    },
    steps: [{ type: "thought", signature: "composed-second-signature" }],
  });
}

async function runFirstCycle(path: string): Promise<void> {
  const requests: CapturedRequest[] = [];
  const app = createApp(baseConfig(path), {
    geminiClient: fakeClient(firstCycleResponder(), requests),
  });
  const reader = openDatabase(path);
  try {
    const admitted = await app.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "first prompt",
    });
    expect(await waitForRunStatus(reader, admitted.runId)).toBe("completed");
    expect(requests).toHaveLength(1);
    // The first cycle must persist exactly the continuation the reopen mutates.
    expect(
      (
        reader
          .prepare("SELECT COUNT(*) AS count FROM transcript_continuations")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  } finally {
    reader.close();
    await app.stop();
  }
}

function assertNegativeReopen(
  reader: AppDatabase,
  runId: string,
  secondRequests: CapturedRequest[],
): void {
  const run = reader
    .prepare("SELECT terminal_code FROM runs WHERE run_id = ?")
    .get(runId) as { terminal_code: string | null };
  expect(run.terminal_code).toBe("MODEL_HISTORY_INCOMPATIBLE");
  // The fake Gemini client was never invoked for the second model call: the
  // incompatibility is detected from local SQLite state before dispatch, so the
  // fake-client seam cannot bypass GeminiInteractionsProvider and no remote
  // continuation id is ever sent.
  expect(secondRequests).toHaveLength(0);
  expect(
    (
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_reservations WHERE run_id = ?",
        )
        .get(runId) as { count: number }
    ).count,
  ).toBe(0);
  expect(
    (
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ? AND event_name = 'usage.reserved'",
        )
        .get(runId) as { count: number }
    ).count,
  ).toBe(0);
  // No false assistant transcript was appended for the failed second run.
  expect(
    (
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant'",
        )
        .get() as { count: number }
    ).count,
  ).toBe(1);
  // Finalization happened exactly once for the failed run.
  expect(
    (
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM run_journal_entries WHERE run_id = ? AND event_name = 'finalize.failed'",
        )
        .get(runId) as { count: number }
    ).count,
  ).toBe(1);
}

describe("composed provider integration (createApp -> GeminiProvider -> fake client)", () => {
  it("runs one prompt through the composed snapshot-driven flow with no network", async () => {
    const db = tempDbPath();
    const requests: CapturedRequest[] = [];
    const app = createApp(baseConfig(db.path), {
      geminiClient: fakeClient(
        () => ({
          output_text: "composed answer",
          id: "interaction-1",
          usage: {
            total_tokens: 30,
            total_input_tokens: 10,
            total_output_tokens: 20,
          },
          steps: [{ type: "thought", signature: "opaque-signature" }],
        }),
        requests,
      ),
    });
    const reader = openDatabase(db.path);
    try {
      const admitted = await app.runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "Hello composed",
      });
      const status = await waitForRunStatus(reader, admitted.runId);
      expect(status).toBe("completed");
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.model).toBe("gemini-3.5-flash");
      expect(request.store).toBe(false);
      expect("previous_interaction_id" in request).toBe(false);
      expect(typeof request.system_instruction).toBe("string");
      const userInput = request.input?.find(
        (entry) => entry.type === "user_input",
      );
      expect(userInput?.content?.[0]?.text).toBe("Hello composed");

      const reservation = reader
        .prepare("SELECT status FROM usage_reservations")
        .get() as { status: string } | undefined;
      expect(reservation?.status).toBe("settled");
      const record = reader
        .prepare("SELECT outcome FROM usage_records")
        .get() as { outcome: string } | undefined;
      expect(record?.outcome).toBe("settled");
      const assistant = reader
        .prepare(
          "SELECT role, continuation_required, model_call_id FROM transcript_entries WHERE role = 'assistant'",
        )
        .get() as
        | {
            role: string;
            continuation_required: number;
            model_call_id: string | null;
          }
        | undefined;
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.continuation_required).toBe(1);
      expect(assistant?.model_call_id).toBeTruthy();
      const continuation = reader
        .prepare("SELECT continuation_version FROM transcript_continuations")
        .get() as { continuation_version: string } | undefined;
      expect(continuation?.continuation_version).toBe(
        "gemini-thought-signature-v1",
      );
      const accepted = reader
        .prepare(
          "SELECT payload_json FROM run_journal_entries WHERE event_name = 'run.accepted'",
        )
        .get() as { payload_json: string } | undefined;
      const payload = JSON.parse(accepted!.payload_json);
      expect(payload.modelId).toBe("gemini-3.5-flash");
      expect(payload.harnessId).toBe("builtin-step");
      expect(payload.resourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.tokenEstimatorRevision).toBe("heuristic-v1");
      expect(JSON.stringify(payload)).not.toContain("GEMINI_API_KEY");
    } finally {
      reader.close();
      await app.stop();
      db.cleanup();
    }
  });

  it("reconstructs the persisted continuation on a second cycle after reopen", async () => {
    const db = tempDbPath();
    const firstRequests: CapturedRequest[] = [];
    const first = createApp(baseConfig(db.path), {
      geminiClient: fakeClient(
        () => ({
          output_text: "first answer",
          id: "interaction-1",
          usage: {
            total_tokens: 30,
            total_input_tokens: 10,
            total_output_tokens: 20,
          },
          steps: [{ type: "thought", signature: "opaque-signature" }],
        }),
        firstRequests,
      ),
    });
    let reader = openDatabase(db.path);
    const firstAdmit = await first.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "first prompt",
    });
    expect(await waitForRunStatus(reader, firstAdmit.runId)).toBe("completed");
    expect(firstRequests).toHaveLength(1);
    reader.close();
    await first.stop();

    const secondRequests: CapturedRequest[] = [];
    const second = createApp(baseConfig(db.path), {
      geminiClient: fakeClient(
        () => ({
          output_text: "second answer",
          id: "interaction-2",
          usage: {
            total_tokens: 24,
            total_input_tokens: 12,
            total_output_tokens: 12,
          },
          steps: [{ type: "thought", signature: "opaque-signature-2" }],
        }),
        secondRequests,
      ),
    });
    reader = openDatabase(db.path);
    const secondAdmit = await second.runtime.admit({
      session: { kind: "main", agentId: "primary" },
      input: "second prompt",
    });
    const terminal = await waitForRunStatus(reader, secondAdmit.runId);
    expect(terminal).toBe("completed");
    expect(secondRequests).toHaveLength(1);
    const thought = secondRequests[0]!.input?.find(
      (entry) => entry.type === "thought",
    );
    expect(thought).toBeDefined();
    expect("previous_interaction_id" in secondRequests[0]!).toBe(false);
    // The first run's durable snapshot identity survives the close/reopen cycle.
    const firstAccepted = reader
      .prepare(
        "SELECT payload_json FROM run_journal_entries WHERE event_name = 'run.accepted' ORDER BY sequence ASC LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;
    const firstPayload = JSON.parse(firstAccepted!.payload_json);
    expect(firstPayload.harnessId).toBe("builtin-step");
    expect(firstPayload.resourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(firstPayload)).not.toContain("GEMINI_API_KEY");
    reader.close();
    await second.stop();
    db.cleanup();
  });

  it("fails a composed pre-billable rejection without a false successful transcript", async () => {
    const db = tempDbPath();
    const requests: CapturedRequest[] = [];
    const app: App = createApp(baseConfig(db.path), {
      geminiClient: fakeClient(() => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }, requests),
    });
    const reader = openDatabase(db.path);
    try {
      const admitted = await app.runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "rate limited prompt",
      });
      const terminal = await waitForRunStatus(reader, admitted.runId);
      expect(terminal).toBe("failed");
      expect(requests).toHaveLength(1);
      const reservation = reader
        .prepare("SELECT status FROM usage_reservations")
        .get() as { status: string } | undefined;
      expect(reservation?.status).toBe("released");
      const assistant = reader
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant'",
        )
        .get() as { count: number };
      expect(assistant.count).toBe(0);
    } finally {
      reader.close();
      await app.stop();
      db.cleanup();
    }
  });

  it("fails a composed reopen when the required persisted continuation is missing", async () => {
    const db = tempDbPath();
    await runFirstCycle(db.path);

    // Deterministic mutation: remove the required continuation while the
    // assistant transcript entry still requires it.
    const mutator = openDatabase(db.path);
    mutator.prepare("DELETE FROM transcript_continuations").run();
    mutator.close();

    const secondRequests: CapturedRequest[] = [];
    const second = createApp(narrowConfig(db.path), {
      geminiClient: fakeClient(secondCycleResponder(), secondRequests),
    });
    const reader = openDatabase(db.path);
    try {
      const admitted = await second.runtime.admit({
        session: { kind: "main", agentId: "primary" },
        input: "second prompt",
      });
      expect(await waitForRunStatus(reader, admitted.runId)).toBe("failed");
      assertNegativeReopen(reader, admitted.runId, secondRequests);

      // Lane released: a later admit on the same session is accepted once the
      // failed run's drain completes. capacity 1 makes the release observable.
      let nextRunId: string | undefined;
      for (let i = 0; i < 300 && !nextRunId; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const next = await second.runtime.admit({
            session: { kind: "main", agentId: "primary" },
            input: "third prompt",
          });
          nextRunId = next.runId;
        } catch {
          /* lane still draining the failed second run */
        }
      }
      expect(nextRunId).toBeDefined();
      expect(nextRunId).not.toBe(admitted.runId);
      // Let the third run drain so the database is not closed mid-flight.
      if (nextRunId) await waitForRunStatus(reader, nextRunId);
    } finally {
      reader.close();
      await second.stop();
      db.cleanup();
    }
  });

  it.each([
    [
      "the persisted continuation payload is empty",
      "continuation_payload",
      new Uint8Array(),
    ],
    [
      "the persisted continuation payload is malformed",
      "continuation_payload",
      new Uint8Array([0xff]),
    ],
    [
      "the persisted continuation version is unsupported",
      "continuation_version",
      "gemini-thought-signature-v2",
    ],
    [
      "the persisted continuation provider association is wrong",
      "provider_id",
      "other-provider",
    ],
    [
      "the persisted continuation model association is wrong",
      "model_id",
      "gemini-other-model",
    ],
  ])(
    "fails a composed reopen before provider/reservation when %s",
    async (_case, column, value) => {
      const db = tempDbPath();
      await runFirstCycle(db.path);

      const mutator = openDatabase(db.path);
      mutator
        .prepare(`UPDATE transcript_continuations SET ${column} = ?`)
        .run(value);
      mutator.close();

      const secondRequests: CapturedRequest[] = [];
      const second = createApp(baseConfig(db.path), {
        geminiClient: fakeClient(secondCycleResponder(), secondRequests),
      });
      const reader = openDatabase(db.path);
      try {
        const admitted = await second.runtime.admit({
          session: { kind: "main", agentId: "primary" },
          input: "second prompt",
        });
        expect(await waitForRunStatus(reader, admitted.runId)).toBe("failed");
        assertNegativeReopen(reader, admitted.runId, secondRequests);
      } finally {
        reader.close();
        await second.stop();
        db.cleanup();
      }
    },
  );
});
