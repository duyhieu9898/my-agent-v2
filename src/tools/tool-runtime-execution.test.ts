import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolCallId } from "../core/identities.js";
import type { NormalizedToolRequest } from "./contracts.js";
import {
  createTempWorkspace,
  setupTestRuntime,
} from "./tool-runtime.test-support.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  describe("Invocation Normalization & Argument Mutation Isolation", () => {
    it("prevents caller mutation of path, content, mode, and limit after admission from altering execution", async () => {
      const tempWs = createTempWorkspace();
      try {
        fs.writeFileSync(
          path.join(tempWs.workspaceRoot, "read.txt"),
          "hello world",
        );
        const { runtime, approvalCoordinator, batchContext } = setupTestRuntime(
          tempWs.workspaceRoot,
        );

        // Auto-approve using deterministic listener hook (no sleep)
        approvalCoordinator.onRequest((binding) => {
          approvalCoordinator.resolveApproval(
            binding.approvalId,
            batchContext.runId,
            "allow-once",
          );
        });

        const rawArguments: Record<string, unknown> = {
          path: "write.txt",
          content: "initial content",
          mode: "create",
        };

        const requests: NormalizedToolRequest[] = [
          {
            toolCallId: createToolCallId("tcall_1"),
            modelCallId: batchContext.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments,
          },
        ];

        const batchPromise = runtime.executeBatch(requests, batchContext);

        // Mutate rawArguments fields immediately after admission
        rawArguments["path"] = "../escape.txt";
        rawArguments["content"] = "HACKED";
        rawArguments["mode"] = "write";

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ok).toBe(true);

        // Verify written file in temp workspace has original content
        const writtenPath = path.join(tempWs.workspaceRoot, "write.txt");
        expect(fs.existsSync(writtenPath)).toBe(true);
        expect(fs.readFileSync(writtenPath, "utf8")).toBe("initial content");

        // Verify outcome contains immutable normalized arguments
        expect(outcomes[0]!.normalizedArguments).toEqual({
          path: "write.txt",
          content: "initial content",
          mode: "create",
        });
      } finally {
        tempWs.cleanup();
      }
    });

    it("ensures successful and admitted failed outcomes retain normalized arguments", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_deny"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.read_text",
          rawArguments: { path: ".env" },
        },
      ];

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(outcomes[0]!.normalizedArguments).toEqual({ path: ".env" });
    });
  });

  it("proves caller mutation after admission cannot alter normalized arguments", async () => {
    const { runtime, approvalCoordinator, batchContext, cleanup } =
      setupTestRuntime();

    try {
      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const mutableArgs = {
        path: "mutable.txt",
        content: "original",
        mode: "create" as const,
      };

      const rawReq: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_2"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.write_text",
        rawArguments: mutableArgs,
      };

      const executePromise = runtime.executeBatch([rawReq], batchContext);

      // Mutate raw input object immediately after admission
      mutableArgs.content = "HACKED_CONTENT";

      const outcomes = await executePromise;
      const outcome = outcomes[0]!;
      expect(outcome.ok).toBe(true);
      expect(outcome.normalizedArguments).toEqual({
        path: "mutable.txt",
        content: "original",
        mode: "create",
      });
    } finally {
      cleanup();
    }
  });
});
