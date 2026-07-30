import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type { NormalizedToolRequest } from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import {
  createWorkspaceReadTextTool,
  createWorkspaceWriteTextTool,
} from "./workspace-tools.js";
import type { WorkspaceFilesystem } from "./workspace-filesystem.js";
import { setupTestRuntime } from "./tool-runtime.test-support.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  describe("Invocation Normalization & Argument Mutation Isolation", () => {
    it("fails extra properties and malformed arguments before policy or execution", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_invalid"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments: { path: "src", extraProp: "unsupported" },
        },
      ];

      const events: string[] = [];
      runtime.onEvent((e) => events.push(e.type));

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_ARGUMENTS_INVALID");

      // Policy & execution events must not fire
      expect(events).not.toContain("policy.evaluated");
      expect(events).not.toContain("tool.started");
    });

    it("rejects the removed replace write mode before policy or execution", async () => {
      const { runtime, batchContext } = setupTestRuntime();
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));

      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_replace_removed"),
            modelCallId: batchContext.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments: {
              path: "file.txt",
              content: "content",
              mode: "replace",
            },
          },
        ],
        batchContext,
      );

      expect(outcome?.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
      expect(events).not.toContain("policy.evaluated");
      expect(events).not.toContain("tool.started");
    });

    it("evaluates argument size against canonical normalized representation", async () => {
      const { registry, policy, approvalCoordinator, batchContext } =
        setupTestRuntime();
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator, {
        maxToolArgumentBytes: 20,
      });

      const requests: NormalizedToolRequest[] = [
        {
          toolCallId: createToolCallId("tcall_1"),
          modelCallId: batchContext.modelCallId,
          ordinal: 1,
          toolName: "workspace.list",
          rawArguments: { path: "very_long_path_name_exceeding_byte_limit" },
        },
      ];

      const outcomes = await runtime.executeBatch(requests, batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
    });
  });

  describe("M3-R3A workspace policy containment", () => {
    it("denies stable symlink reads and writes before approval, start, or execution", async () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), "runtime-workspace-"),
      );
      const workspaceRoot = path.join(parent, "workspace");
      const outsideRoot = path.join(parent, "workspace-escape");
      fs.mkdirSync(workspaceRoot);
      fs.mkdirSync(outsideRoot);
      fs.writeFileSync(
        path.join(outsideRoot, "sentinel.txt"),
        "outside secret",
      );
      fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "outside-dir"));
      const { runtime, approvalCoordinator, batchContext } =
        setupTestRuntime(workspaceRoot);
      const events: string[] = [];
      let approvalRequests = 0;
      runtime.onEvent((event) => events.push(event.type));
      approvalCoordinator.onRequest(() => approvalRequests++);
      try {
        const outcomes = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_symlink_read"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "workspace.read_text",
              rawArguments: { path: "outside-dir/sentinel.txt" },
            },
            {
              toolCallId: createToolCallId("tcall_symlink_write"),
              modelCallId: batchContext.modelCallId,
              ordinal: 2,
              toolName: "workspace.write_text",
              rawArguments: {
                path: "outside-dir/new.txt",
                content: "escaped",
                mode: "create",
              },
            },
          ],
          batchContext,
        );

        expect(outcomes).toHaveLength(2);
        expect(outcomes.map((outcome) => outcome.error?.code)).toEqual([
          "TOOL_POLICY_DENIED",
          "TOOL_POLICY_DENIED",
        ]);
        expect(outcomes.map((outcome) => outcome.terminalState)).toEqual([
          "failed-before-known-side-effect",
          "failed-before-known-side-effect",
        ]);
        expect(approvalRequests).toBe(0);
        expect(events).not.toContain("tool.started");
        expect(
          fs.readFileSync(path.join(outsideRoot, "sentinel.txt"), "utf8"),
        ).toBe("outside secret");
        expect(fs.existsSync(path.join(outsideRoot, "new.txt"))).toBe(false);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  describe("M3-R3-4 certainty evidence", () => {
    function writeRuntime(
      filesystem: WorkspaceFilesystem,
      ids = createSequentialIdFactory(),
      hooks?: import("./tool-runtime.js").ToolRuntimeTestHooks,
    ) {
      const registry = new ToolRegistry();
      registry.register(createWorkspaceWriteTextTool(filesystem));
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(
        registry,
        new WorkspacePolicy(filesystem),
        approvals,
        undefined,
        hooks,
      );
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r34"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      approvals.onRequest((binding) =>
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        ),
      );
      return { runtime, context };
    }

    it("G1 forces only the selected admitted invocation through the missing execution-context fallback", async () => {
      let executions = 0;
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined,
        list: async () => [],
        readTextChunk: async () => ({
          text: "",
          bytesRead: 0,
          fileSizeBytes: 0,
        }),
        inspectTextForWrite: async () => ({ priorState: "none" }),
        createText: async () => {
          executions++;
        },
        writeText: async () => {
          executions++;
        },
      };
      const selected = createToolCallId("r34_missing_context");
      const { runtime, context } = writeRuntime(
        filesystem,
        createSequentialIdFactory(),
        {
          forceMissingExecutionContext: (toolCallId) => toolCallId === selected,
        },
      );
      const events: Array<{
        type: string;
        toolCallId?: string;
        data?: Record<string, unknown>;
      }> = [];
      runtime.onEvent((event) => events.push(event));
      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: selected,
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "workspace.write_text",
            rawArguments: { path: "a.txt", content: "x", mode: "create" },
          },
        ],
        context,
      );
      expect(executions).toBe(0);
      expect(outcome).toMatchObject({
        terminalState: "failed-before-known-side-effect",
        normalizedArguments: { path: "a.txt", content: "x", mode: "create" },
        error: { code: "TOOL_IMPLEMENTATION_FAILED" },
      });
      expect(
        events.filter((event) =>
          [
            "tool.failed",
            "tool.started",
            "tool.completed",
            "tool.cancelled",
          ].includes(event.type),
        ),
      ).toEqual([
        expect.objectContaining({
          type: "tool.failed",
          toolCallId: selected,
          data: expect.objectContaining({ code: "TOOL_IMPLEMENTATION_FAILED" }),
        }),
      ]);
    });

    describe("G1 remaining pre-start admission matrix", () => {
      it("handles invalid arguments admission failure before I/O or start", async () => {
        let executions = 0;
        let fsCalls = 0;
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => {
            fsCalls++;
            return [];
          },
          readTextChunk: async () => {
            fsCalls++;
            return { text: "", bytesRead: 0, fileSizeBytes: 0 };
          },
          inspectTextForWrite: async () => {
            fsCalls++;
            return { priorState: "none" };
          },
          createText: async () => {
            fsCalls++;
            executions++;
          },
          writeText: async () => {
            fsCalls++;
            executions++;
          },
        };
        const { runtime, context } = writeRuntime(filesystem);
        const events: Array<{ type: string; toolCallId?: string }> = [];
        runtime.onEvent((e) => events.push(e));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g1_invalid"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "workspace.write_text",
              rawArguments: { path: 123 as any, content: "x", mode: "create" },
            },
          ],
          context,
        );

        expect(executions).toBe(0);
        expect(fsCalls).toBe(0);
        expect(outcome).toMatchObject({
          terminalState: "failed-before-known-side-effect",
          error: { code: "TOOL_ARGUMENTS_INVALID" },
        });
        expect(
          events.filter((e) =>
            [
              "tool.started",
              "tool.completed",
              "tool.failed",
              "tool.cancelled",
            ].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({
            type: "tool.failed",
            toolCallId: "tcall_g1_invalid",
          }),
        ]);
      });

      it("handles policy denial before I/O or start", async () => {
        let fsCalls = 0;
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => [],
          readTextChunk: async () => {
            fsCalls++;
            return { text: "", bytesRead: 0, fileSizeBytes: 0 };
          },
          inspectTextForWrite: async () => ({ priorState: "none" }),
          createText: async () => {},
          writeText: async () => {},
        };
        const registry = new ToolRegistry();
        registry.register(createWorkspaceReadTextTool(filesystem));
        registry.freeze();
        const ids = createSequentialIdFactory();
        const runtime = new ToolRuntime(
          registry,
          new WorkspacePolicy(filesystem),
          new ApprovalCoordinator(ids),
        );
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g1_policy"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        const events: Array<{ type: string; toolCallId?: string }> = [];
        runtime.onEvent((e) => events.push(e));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g1_policy"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "workspace.read_text",
              rawArguments: { path: ".env" },
            },
          ],
          context,
        );

        expect(fsCalls).toBe(0);
        expect(outcome).toMatchObject({
          terminalState: "failed-before-known-side-effect",
          error: { code: "TOOL_POLICY_DENIED" },
        });
        expect(
          events.filter((e) =>
            [
              "tool.started",
              "tool.completed",
              "tool.failed",
              "tool.cancelled",
            ].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({
            type: "tool.failed",
            toolCallId: "tcall_g1_policy",
          }),
        ]);
      });

      it("handles approval denial before I/O or start", async () => {
        let executions = 0;
        let fsCalls = 0;
        const ids = createSequentialIdFactory();
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => [],
          readTextChunk: async () => ({
            text: "",
            bytesRead: 0,
            fileSizeBytes: 0,
          }),
          inspectTextForWrite: async () => ({ priorState: "none" }),
          createText: async () => {
            fsCalls++;
            executions++;
          },
          writeText: async () => {
            fsCalls++;
            executions++;
          },
        };
        const registry = new ToolRegistry();
        registry.register(createWorkspaceWriteTextTool(filesystem));
        registry.freeze();
        const approvals = new ApprovalCoordinator(ids);
        const runtime = new ToolRuntime(
          registry,
          new WorkspacePolicy(filesystem),
          approvals,
        );
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g1_deny"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest((binding) =>
          approvals.resolveApproval(binding.approvalId, context.runId, "deny"),
        );

        const events: Array<{ type: string; toolCallId?: string }> = [];
        runtime.onEvent((e) => events.push(e));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g1_appr_deny"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "workspace.write_text",
              rawArguments: { path: "a.txt", content: "x", mode: "create" },
            },
          ],
          context,
        );

        expect(executions).toBe(0);
        expect(fsCalls).toBe(0);
        expect(outcome).toMatchObject({
          terminalState: "failed-before-known-side-effect",
          error: { code: "TOOL_APPROVAL_DENIED" },
        });
        expect(
          events.filter((e) =>
            [
              "tool.started",
              "tool.completed",
              "tool.failed",
              "tool.cancelled",
            ].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({
            type: "tool.failed",
            toolCallId: "tcall_g1_appr_deny",
          }),
        ]);
      });

      it("handles approval expiry using fake timers before I/O or start", async () => {
        vi.useFakeTimers();
        try {
          let executions = 0;
          let fsCalls = 0;
          const ids = createSequentialIdFactory();
          const filesystem: WorkspaceFilesystem = {
            preflight: async () => undefined,
            list: async () => [],
            readTextChunk: async () => ({
              text: "",
              bytesRead: 0,
              fileSizeBytes: 0,
            }),
            inspectTextForWrite: async () => ({ priorState: "none" }),
            createText: async () => {
              fsCalls++;
              executions++;
            },
            writeText: async () => {
              fsCalls++;
              executions++;
            },
          };
          const registry = new ToolRegistry();
          registry.register(createWorkspaceWriteTextTool(filesystem));
          registry.freeze();
          const approvals = new ApprovalCoordinator(ids);
          const runtime = new ToolRuntime(
            registry,
            new WorkspacePolicy(filesystem),
            approvals,
          );
          const context: ToolBatchContext = {
            agentId: createAgentId("primary"),
            sessionKey: createSessionKey("agent:primary:g1_exp"),
            sessionId: ids.nextSessionId(),
            runId: ids.nextRunId(),
            attemptId: ids.nextAttemptId(),
            modelCallId: ids.nextModelCallId(),
            workspaceRoot: "/workspace",
            sandboxProfile: "host-workspace-v1",
            totalRunToolCalls: 0,
          };
          approvals.onRequest(() => {
            vi.advanceTimersByTime(35000);
          });

          const events: Array<{ type: string; toolCallId?: string }> = [];
          runtime.onEvent((e) => events.push(e));

          const [outcome] = await runtime.executeBatch(
            [
              {
                toolCallId: createToolCallId("tcall_g1_exp"),
                modelCallId: context.modelCallId,
                ordinal: 1,
                toolName: "workspace.write_text",
                rawArguments: { path: "a.txt", content: "x", mode: "create" },
              },
            ],
            context,
          );

          expect(executions).toBe(0);
          expect(fsCalls).toBe(0);
          expect(outcome).toMatchObject({
            terminalState: "failed-before-known-side-effect",
            error: { code: "TOOL_APPROVAL_EXPIRED" },
          });
          expect(
            events.filter((e) =>
              [
                "tool.started",
                "tool.completed",
                "tool.failed",
                "tool.cancelled",
              ].includes(e.type),
            ),
          ).toEqual([
            expect.objectContaining({
              type: "tool.failed",
              toolCallId: "tcall_g1_exp",
            }),
          ]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("handles approval cancellation before I/O or start", async () => {
        let executions = 0;
        let fsCalls = 0;
        const ids = createSequentialIdFactory();
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => [],
          readTextChunk: async () => ({
            text: "",
            bytesRead: 0,
            fileSizeBytes: 0,
          }),
          inspectTextForWrite: async () => ({ priorState: "none" }),
          createText: async () => {
            fsCalls++;
            executions++;
          },
          writeText: async () => {
            fsCalls++;
            executions++;
          },
        };
        const registry = new ToolRegistry();
        registry.register(createWorkspaceWriteTextTool(filesystem));
        registry.freeze();
        const approvals = new ApprovalCoordinator(ids);
        const runtime = new ToolRuntime(
          registry,
          new WorkspacePolicy(filesystem),
          approvals,
        );
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g1_cancel"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest(() => {
          approvals.cancelPendingForRun(context.runId);
        });

        const events: Array<{ type: string; toolCallId?: string }> = [];
        runtime.onEvent((e) => events.push(e));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g1_cancel"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "workspace.write_text",
              rawArguments: { path: "a.txt", content: "x", mode: "create" },
            },
          ],
          context,
        );

        expect(executions).toBe(0);
        expect(fsCalls).toBe(0);
        expect(outcome).toMatchObject({
          terminalState: "cancelled-with-no-known-side-effect",
          error: { code: "TOOL_CANCELLED" },
        });
        expect(
          events.filter((e) =>
            [
              "tool.started",
              "tool.completed",
              "tool.failed",
              "tool.cancelled",
            ].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({
            type: "tool.cancelled",
            toolCallId: "tcall_g1_cancel",
          }),
        ]);
      });

      it("handles already-aborted signal before I/O or start", async () => {
        let fsCalls = 0;
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => [],
          readTextChunk: async () => {
            fsCalls++;
            return { text: "data", bytesRead: 4, fileSizeBytes: 4 };
          },
          inspectTextForWrite: async () => ({ priorState: "none" }),
          createText: async () => {},
          writeText: async () => {},
        };
        const registry = new ToolRegistry();
        registry.register(createWorkspaceReadTextTool(filesystem));
        registry.freeze();
        const ids = createSequentialIdFactory();
        const runtime = new ToolRuntime(
          registry,
          new WorkspacePolicy(filesystem),
          new ApprovalCoordinator(ids),
        );
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g1_aborted"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        const events: Array<{ type: string; toolCallId?: string }> = [];
        runtime.onEvent((e) => events.push(e));

        const controller = new AbortController();
        controller.abort();

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g1_aborted"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "workspace.read_text",
              rawArguments: { path: "a.txt" },
            },
          ],
          context,
          controller.signal,
        );

        expect(fsCalls).toBe(0);
        expect(outcome).toMatchObject({
          terminalState: "cancelled-with-no-known-side-effect",
          error: { code: "TOOL_CANCELLED" },
        });
        expect(
          events.filter((e) =>
            [
              "tool.started",
              "tool.completed",
              "tool.failed",
              "tool.cancelled",
            ].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({
            type: "tool.cancelled",
            toolCallId: "tcall_g1_aborted",
          }),
        ]);
      });
    });
  });
});
