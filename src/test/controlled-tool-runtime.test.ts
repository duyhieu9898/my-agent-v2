import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../bootstrap/create-app.js";
import { type AppConfig } from "../config/config.schema.js";
import type { ModelResult } from "../models/contracts.js";
import type { InteractionsClient } from "../models/gemini-interactions-provider.js";

function createTestConfig(dataDir: string, workspaceDir: string): AppConfig {
  return {
    nodeEnv: "test",
    logLevel: "info",
    dataDir,
    workspaceDir,
    database: { path: join(dataDir, "agent.sqlite") },
    agent: {
      defaultId: "primary",
      model: {
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        geminiApiKeyEnvironmentVariable: "GEMINI_API_KEY",
        contextTokenBudget: 12000,
      },
    },
    gateway: { host: "127.0.0.1", port: 0 },
    runtime: {
      maxConcurrentModelCalls: 2,
      perSessionQueueCapacity: 5,
      runTimeoutMs: 30000,
    },
    usage: {
      captureProfile: "production",
      maxOutputTokens: 8192,
      thinkingTokens: 0,
      reservationSafetyMarginTokens: 256,
      capPolicies: [],
      priceCatalog: [],
    },
  };
}

class FakeInteractionsClient {
  public readonly calls: unknown[] = [];
  private stepIndex = 0;
  public constructor(
    private readonly responses: Array<Record<string, unknown>>,
  ) {}

  public readonly interactions = {
    create: async (params: unknown) => {
      this.calls.push(params);
      const res =
        this.responses[this.stepIndex] ??
        this.responses[this.responses.length - 1];
      this.stepIndex++;
      return res;
    },
  };
}

describe("Controlled Side-Effect Verification (M3-G28)", () => {
  it("executes Gateway -> agent.run -> tool request -> approval.requested -> approval.resolve -> atomic file write -> checkpoint continue -> final assistant response", async () => {
    const baseDir = join(tmpdir(), `m3-controlled-test-${Date.now()}`);
    const dataDir = join(baseDir, "data");
    const workspaceDir = join(baseDir, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    // Step 1 response: Model requests workspace.write_text
    const step1Response = {
      id: "int_step1",
      function_calls: [
        {
          id: "call_write1",
          name: "workspace.write_text",
          args: {
            path: "greeting.txt",
            content: "Hello from Tool Runtime M3!",
            mode: "create",
          },
        },
      ],
      usage: {
        total_tokens: 100,
        total_input_tokens: 60,
        total_output_tokens: 40,
      },
    };

    // Step 2 response: Model returns final assistant text response after tool completion
    const step2Response = {
      id: "int_step2",
      output_text: "File created successfully!",
      usage: {
        total_tokens: 120,
        total_input_tokens: 80,
        total_output_tokens: 40,
      },
    };

    const fakeClient = new FakeInteractionsClient([
      step1Response,
      step2Response,
    ]);
    const config = createTestConfig(dataDir, workspaceDir);
    const app = createApp(config, {
      geminiClient: fakeClient as unknown as InteractionsClient,
    });

    await app.start();

    try {
      const wsUrl = `ws://127.0.0.1:${app.gateway.port}/ws`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const events: any[] = [];
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        events.push(parsed);
      });

      // 1. Connect frame
      ws.send(
        JSON.stringify({
          type: "req",
          id: "msg_1",
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              name: "controlled-test-client",
              version: "1.0.0",
              mode: "cli",
            },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 100));

      // 2. agent.run frame
      ws.send(
        JSON.stringify({
          type: "req",
          id: "msg_2",
          method: "agent.run",
          params: {
            session: {
              kind: "main",
              agentId: "primary",
            },
            input: "Please create greeting.txt",
          },
        }),
      );

      // Wait for approval.requested event or approval item
      let approvalId: string | undefined;
      for (let i = 0; i < 30; i++) {
        const reqEvent = events.find(
          (e) => e.type === "event" && e.event === "approval.requested",
        );
        if (reqEvent) {
          approvalId = reqEvent.payload?.approvalId;
        }
        if (approvalId) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!approvalId) {
        console.log("EVENTS AT FAIL:", JSON.stringify(events, null, 2));
      }

      // If event didn't carry approvalId in wrapper, check logged events
      if (!approvalId) {
        const reqEvent = events.find(
          (e) =>
            e.type === "event" &&
            e.event?.data?.summary?.includes("greeting.txt"),
        );
        if (reqEvent) {
          approvalId = reqEvent.event.approvalId;
        }
      }

      expect(approvalId).toBeDefined();
      const runId = events.find((e) => e.type === "res" && e.id === "msg_2")
        ?.payload?.runId;
      expect(runId).toBeDefined();

      // 3. Resolve approval via Gateway method approval.resolve
      ws.send(
        JSON.stringify({
          type: "req",
          id: "msg_3",
          method: "approval.resolve",
          params: {
            approvalId,
            runId,
            decision: "allow-once",
          },
        }),
      );

      // Wait for run.completed event
      for (let i = 0; i < 50; i++) {
        const completed = events.find(
          (e) => e.type === "event" && e.event === "run.completed",
        );
        if (completed) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const completedEvent = events.find(
        (e) => e.type === "event" && e.event === "run.completed",
      );
      if (!completedEvent) {
        console.log("EVENTS AT FINISH:", JSON.stringify(events, null, 2));
      }
      expect(completedEvent).toBeDefined();

      // Verify exact file created in workspace
      const createdFile = join(workspaceDir, "greeting.txt");
      const content = readFileSync(createdFile, "utf8");
      expect(content).toBe("Hello from Tool Runtime M3!");

      ws.close();
    } finally {
      await app.stop();
      rmSync(baseDir, { recursive: true, force: true });
    }
  }, 15000);
});
