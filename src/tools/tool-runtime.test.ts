import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { AppError } from "../core/errors.js";
import {
  createAgentId,
  createAttemptId,
  createModelCallId,
  createRunId,
  createSessionId,
  createSessionKey,
  createToolCallId,
} from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import type { ApprovalRequestBinding } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import type {
  NormalizedToolRequest,
  ToolDescriptor,
  ToolExecutionContext,
  ToolRegistration,
} from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import {
  createWorkspaceListTool,
  createWorkspaceReadTextTool,
  createWorkspaceWriteTextTool,
} from "./workspace-tools.js";
import type { WorkspaceFilesystem } from "./workspace-filesystem.js";

describe("ToolRuntime — Invocation Snapshot, Identity & Approval Binding", () => {
  function createTempWorkspace() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-ws-"));
    return {
      workspaceRoot: tempDir,
      cleanup: () => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      },
    };
  }

  function setupTestRuntime(customWorkspaceRoot?: string) {
    const idFactory = createSequentialIdFactory();
    const workspaceFilesystem = new FsSafeWorkspaceFilesystem();
    const registry = new ToolRegistry();
    registry.register(createWorkspaceListTool(workspaceFilesystem));
    registry.register(createWorkspaceReadTextTool(workspaceFilesystem));
    registry.register(createWorkspaceWriteTextTool(workspaceFilesystem));
    registry.freeze();

    const policy = new WorkspacePolicy(workspaceFilesystem);
    const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
    const runtime = new ToolRuntime(registry, policy, approvalCoordinator, {
      maxToolArgumentBytes: 1024,
    });

    const tempWs = createTempWorkspace();
    const workspaceRoot = customWorkspaceRoot ?? tempWs.workspaceRoot;

    const batchContext: ToolBatchContext = {
      agentId: createAgentId("primary"),
      sessionKey: createSessionKey("agent:primary:test"),
      sessionId: idFactory.nextSessionId(),
      runId: idFactory.nextRunId(),
      attemptId: idFactory.nextAttemptId(),
      modelCallId: idFactory.nextModelCallId(),
      workspaceRoot,
      sandboxProfile: "host-workspace-v1",
      totalRunToolCalls: 0,
    };

    return {
      idFactory,
      registry,
      policy,
      approvalCoordinator,
      runtime,
      batchContext,
      cleanup: tempWs.cleanup,
    };
  }

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
      const { idFactory, registry, policy, approvalCoordinator, batchContext } =
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
    it("binds normalized side-effect targetPath through approval and execution", async () => {
      const tempWorkspace = createTempWorkspace();
      const escapePath = path.join(
        path.dirname(tempWorkspace.workspaceRoot),
        "m3-r3ae-escape.txt",
      );
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime(
        tempWorkspace.workspaceRoot,
      );
      const events: string[] = [];
      let approvalRequests = 0;
      let capturedBinding: ApprovalRequestBinding | undefined;
      const rawArguments: Record<string, unknown> = {
        path: "sub/../safe.txt",
        content: "normalized target",
        mode: "create",
      };
      runtime.onEvent((event) => events.push(event.type));
      approvalCoordinator.onRequest((binding) => {
        approvalRequests++;
        capturedBinding = binding;
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });
      try {
        expect(
          fs.existsSync(path.join(tempWorkspace.workspaceRoot, "safe.txt")),
        ).toBe(false);
        expect(fs.existsSync(escapePath)).toBe(false);

        const execution = runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_normalized_approval"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "workspace.write_text",
              rawArguments,
            },
          ],
          batchContext,
        );
        rawArguments.path = "../m3-r3ae-escape.txt";
        rawArguments.content = "mutated";

        const outcomes = await execution;
        expect(approvalRequests).toBe(1);
        expect(capturedBinding).toMatchObject({
          toolName: "workspace.write_text",
          targetPath: "safe.txt",
          decision: "require-approval",
        });
        expect(capturedBinding?.targetPath).not.toBe("sub/../safe.txt");
        expect(
          events.filter((event) => event === "approval.requested"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event === "approval.resolved"),
        ).toHaveLength(1);
        expect(events.filter((event) => event === "tool.started")).toHaveLength(
          1,
        );
        expect(
          events.filter((event) => event === "tool.completed"),
        ).toHaveLength(1);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          ok: true,
          terminalState: "completed",
          normalizedArguments: {
            path: "sub/../safe.txt",
            content: "normalized target",
            mode: "create",
          },
          result: { path: "safe.txt" },
        });
        expect(
          fs.readFileSync(
            path.join(tempWorkspace.workspaceRoot, "safe.txt"),
            "utf8",
          ),
        ).toBe("normalized target");
        expect(fs.existsSync(escapePath)).toBe(false);
      } finally {
        tempWorkspace.cleanup();
      }
    });

    it("binds the normalized policy target as the workspace execution authority", async () => {
      const tempWorkspace = createTempWorkspace();
      fs.writeFileSync(
        path.join(tempWorkspace.workspaceRoot, "safe.txt"),
        "safe",
      );
      const { runtime, batchContext } = setupTestRuntime(
        tempWorkspace.workspaceRoot,
      );
      try {
        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_normalized_path"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "workspace.read_text",
              rawArguments: { path: "sub/../safe.txt" },
            },
          ],
          batchContext,
        );
        expect(outcome).toMatchObject({
          ok: true,
          normalizedArguments: { path: "sub/../safe.txt" },
          result: { path: "safe.txt", text: "safe" },
        });
      } finally {
        tempWorkspace.cleanup();
      }
    });

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

  describe("Host ToolCallId vs Provider Call ID", () => {
    it("keeps providerCallId distinct from host toolCallId and preserves uniqueness on duplicate provider IDs", async () => {
      const { runtime, batchContext } = setupTestRuntime();

      const req1: NormalizedToolRequest = {
        toolCallId: createToolCallId("host_tcall_001"),
        providerCallId: "provider_call_dup",
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "workspace.list",
        rawArguments: { path: "src" },
      };

      const req2: NormalizedToolRequest = {
        toolCallId: createToolCallId("host_tcall_002"),
        providerCallId: "provider_call_dup",
        modelCallId: batchContext.modelCallId,
        ordinal: 2,
        toolName: "workspace.list",
        rawArguments: { path: "src" },
      };

      const outcomes = await runtime.executeBatch([req1, req2], batchContext);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]!.toolCallId).toBe("host_tcall_001");
      expect(outcomes[1]!.toolCallId).toBe("host_tcall_002");
      expect(outcomes[0]!.toolCallId).not.toBe(outcomes[1]!.toolCallId);
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

  describe("Deterministic Policy and Approval Binding Validation", () => {
    it("proves side-effecting tool executes after explicit single-use approval", async () => {
      const { runtime, approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async (_args, context) => {
          context.markIoStarted();
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeSideEffectTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_side_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(true);
      expect(ioExecuted).toBe(true);

      expect(events).toEqual([
        "tool.requested",
        "policy.evaluated",
        "approval.requested",
        "approval.resolved",
        "tool.batch.planned",
        "tool.started",
        "tool.completed",
        "tool.batch.completed",
      ]);
    });

    it("prevents execution and tool.started when binding validation or wrong runId fails", async () => {
      const { approvalCoordinator, batchContext } = setupTestRuntime();

      let ioExecuted = false;
      const customRegistry = new ToolRegistry();
      const fakeSideEffectTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeSideEffectTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      approvalCoordinator.onRequest((binding) => {
        const wrongRunId = createRunId("00000000-0000-4000-8000-000000000099");
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          wrongRunId,
          "allow-once",
        );
        approvalCoordinator.cancelPendingForRun(batchContext.runId);
      });

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_side_2"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves runtime sandbox profile drift invalidates approval before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };

      customRegistry.register(fakeTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const origGetBinding =
        approvalCoordinator.getBindingByToolCallId.bind(approvalCoordinator);
      approvalCoordinator.getBindingByToolCallId = (tId) => {
        const b = origGetBinding(tId);
        return b
          ? { ...b, sandboxProfile: "drifted-sandbox-profile" }
          : undefined;
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_drift_1"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("prevents execution and tool.started when policy recheck fails or denies", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({
          path: Type.String(),
          action: Type.String(),
        }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Fake side effect action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      let initialCheck = true;
      const policy: any = {
        evaluateInvocation: async () => {
          if (initialCheck) {
            initialCheck = false;
            return {
              decision: "require-approval",
              policyProfile: "profile-1",
              policyVersion: "1.0.0",
              reason: "requires approval",
            };
          }
          return {
            decision: "deny",
            policyProfile: "profile-1",
            policyVersion: "1.0.0",
            reason: "denied on recheck",
          };
        },
      };

      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_recheck_deny"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt", action: "run" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves workspace drift invalidates approval before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      const policy = new WorkspacePolicy(new FsSafeWorkspaceFilesystem());
      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const origGetBinding =
        approvalCoordinator.getBindingByToolCallId.bind(approvalCoordinator);
      approvalCoordinator.getBindingByToolCallId = (tId) => {
        const b = origGetBinding(tId);
        return b
          ? { ...b, workspaceDigest: "drifted_workspace_digest" }
          : undefined;
      };

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_ws_drift"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });

    it("proves recheck decision changing from require-approval to allow fails closed before tool.started", async () => {
      const idFactory = createSequentialIdFactory();
      const customRegistry = new ToolRegistry();
      let ioExecuted = false;

      const fakeTool: ToolRegistration = {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "Action",
        redactionRules: [],
        inputLimits: { maxBytes: 1024 },
        outputLimits: { maxBytes: 1024 },
        progressFingerprintVersion: "1.0.0",
        execute: async () => {
          ioExecuted = true;
          return { done: true };
        },
      };
      customRegistry.register(fakeTool);
      customRegistry.freeze();

      let checkCount = 0;
      const policy: any = {
        evaluateInvocation: async () => {
          checkCount++;
          if (checkCount === 1) {
            return {
              decision: "require-approval",
              policyProfile: "profile-1",
              policyVersion: "1.0.0",
              reason: "requires approval",
            };
          }
          return {
            decision: "allow", // Changed to allow on recheck!
            policyProfile: "profile-1",
            policyVersion: "1.0.0",
            reason: "requires approval",
          };
        },
      };

      const approvalCoordinator = new ApprovalCoordinator(idFactory, 5000);
      const customRuntime = new ToolRuntime(
        customRegistry,
        policy,
        approvalCoordinator,
      );

      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) => {
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        );
      });

      const events: string[] = [];
      customRuntime.onEvent((e) => events.push(e.type));

      const req: NormalizedToolRequest = {
        toolCallId: createToolCallId("tcall_allow_recheck"),
        modelCallId: batchContext.modelCallId,
        ordinal: 1,
        toolName: "test.side_effect",
        rawArguments: { path: "test.txt" },
      };

      const outcomes = await customRuntime.executeBatch([req], batchContext);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.error?.code).toBe("TOOL_POLICY_DENIED");
      expect(ioExecuted).toBe(false);
      expect(events).not.toContain("tool.started");
    });
  });

  describe("Frozen R1C policy and authority closure", () => {
    function sideEffectRegistration(
      execute: ToolRegistration["execute"],
    ): ToolRegistration {
      return {
        name: "test.side_effect",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "Fake side effect tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ done: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        approvalSummaryRenderer: () => "approved action",
        redactionRules: [],
        inputLimits: { maxBytes: 100 },
        outputLimits: { maxBytes: 100 },
        progressFingerprintVersion: "1.0.0",
        execute,
      };
    }

    function validPolicy(decision: "allow" | "deny" | "require-approval") {
      return {
        decision,
        policyProfile: "test-policy",
        policyVersion: "1.0.0",
        reason: "test reason",
        ...(decision === "deny" ? {} : { targetPath: "original.txt" }),
        policyConstraints: { scope: "original" },
        redactionMetadata: { paths: "redacted" },
      };
    }

    it.each([
      [undefined, "missing policy result"],
      [
        { ...validPolicy("require-approval"), decision: "unsupported" },
        "unsupported decision",
      ],
      [
        { ...validPolicy("require-approval"), policyConstraints: undefined },
        "missing policy evidence",
      ],
      [validPolicy("allow"), "initial side-effect allow"],
      [validPolicy("deny"), "explicit deny"],
    ])(
      "fails closed for %s before approval, tool.started, or I/O",
      async (policyResult, _label) => {
        const idFactory = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let ioCount = 0;
        registry.register(
          sideEffectRegistration(async () => {
            ioCount++;
            return { done: true };
          }),
        );
        registry.freeze();
        let approvals = 0;
        const approvalsCoordinator = new ApprovalCoordinator(idFactory, 5000);
        approvalsCoordinator.onRequest(() => approvals++);
        const runtime = new ToolRuntime(
          registry,
          { evaluateInvocation: async () => policyResult } as any,
          approvalsCoordinator,
        );
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:test"),
          sessionId: idFactory.nextSessionId(),
          runId: idFactory.nextRunId(),
          attemptId: idFactory.nextAttemptId(),
          modelCallId: idFactory.nextModelCallId(),
          workspaceRoot: process.cwd(),
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("r1c_policy"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "test.side_effect",
              rawArguments: { path: "original.txt" },
            },
          ],
          context,
        );
        expect(outcome!.error?.code).toBe("TOOL_POLICY_DENIED");
        expect(approvals).toBe(0);
        expect(ioCount).toBe(0);
        expect(events).not.toContain("tool.started");
      },
    );

    it("uses admitted authority and exact approved/rechecked constraints after a deterministic policy barrier", async () => {
      const idFactory = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executorContext: any;
      registry.register(
        sideEffectRegistration(async (_args, context) => {
          executorContext = context;
          return { done: true };
        }),
      );
      registry.freeze();
      let releasePolicy!: () => void;
      const policyEntered = new Promise<void>((resolve) => {
        const release = resolve;
        releasePolicy = release;
      });
      let signalPolicyEntered!: () => void;
      const policyStarted = new Promise<void>((resolve) => {
        signalPolicyEntered = resolve;
      });
      let policyCalls = 0;
      const policy = {
        evaluateInvocation: async () => {
          policyCalls++;
          if (policyCalls === 1) {
            signalPolicyEntered();
            await policyEntered;
          }
          return validPolicy("require-approval");
        },
      };
      const approvals = new ApprovalCoordinator(idFactory, 5000);
      let approvedBinding: any;
      const runtime = new ToolRuntime(registry, policy as any, approvals);
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: "/original/workspace",
        sandboxProfile: "original-sandbox",
        totalRunToolCalls: 0,
      };
      const admitted = { ...context };
      approvals.onRequest((binding) => {
        approvedBinding = binding;
        approvals.resolveApproval(
          binding.approvalId,
          admitted.runId,
          "allow-once",
        );
      });
      const result = runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r1c_snapshot"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "test.side_effect",
            rawArguments: { path: "original.txt" },
          },
        ],
        context,
      );

      await policyStarted;
      Object.assign(context as any, {
        agentId: "mutated-agent",
        sessionKey: "mutated-session-key",
        sessionId: "mutated-session-id",
        runId: "mutated-run",
        attemptId: "mutated-attempt",
        modelCallId: "mutated-model-call",
        workspaceRoot: "/mutated/workspace",
        sandboxProfile: "mutated-sandbox",
        totalRunToolCalls: 999,
      });
      releasePolicy();
      const [outcome] = await result;

      expect(outcome!.ok).toBe(true);
      expect(approvedBinding).toMatchObject({
        agentId: admitted.agentId,
        sessionKey: admitted.sessionKey,
        sessionId: admitted.sessionId,
        runId: admitted.runId,
        attemptId: admitted.attemptId,
        modelCallId: admitted.modelCallId,
        sandboxProfile: "original-sandbox",
      });
      expect(executorContext).toMatchObject({
        agentId: admitted.agentId,
        workspaceRoot: "/original/workspace",
        sandboxProfile: "original-sandbox",
        targetPath: "original.txt",
        policyConstraints: { scope: "original" },
        inputLimits: { maxBytes: 100 },
        outputLimits: { maxBytes: 100 },
      });
      expect(
        JSON.stringify({ approvedBinding, executorContext }),
      ).not.toContain("mutated");
    });

    it("uses the original registry renderer and executor after replacement attempts", async () => {
      const idFactory = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let originalExecutorCalls = 0;
      let replacementExecutorCalls = 0;
      let originalRendererCalls = 0;
      let replacementRendererCalls = 0;
      registry.register({
        ...sideEffectRegistration(async () => {
          originalExecutorCalls++;
          return { done: true };
        }),
        approvalSummaryRenderer: () => {
          originalRendererCalls++;
          return "original approval summary";
        },
      });
      const originalExecuteOperation = registry.execute;
      const originalRenderOperation = registry.renderApprovalSummary;
      registry.freeze();

      expect(() => {
        (registry as any).execute = async () => {
          replacementExecutorCalls++;
          return { done: true };
        };
      }).toThrow();
      expect(() => {
        (registry as any).renderApprovalSummary = () => {
          replacementRendererCalls++;
          return "replacement approval summary";
        };
      }).toThrow();
      expect(registry.execute).toBe(originalExecuteOperation);
      expect(registry.renderApprovalSummary).toBe(originalRenderOperation);

      const approvals = new ApprovalCoordinator(idFactory, 5000);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async () => validPolicy("require-approval"),
        } as any,
        approvals,
      );
      let approvalSummary: string | undefined;
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:test"),
        sessionId: idFactory.nextSessionId(),
        runId: idFactory.nextRunId(),
        attemptId: idFactory.nextAttemptId(),
        modelCallId: idFactory.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      approvals.onRequest((binding) => {
        approvalSummary = binding.actionSummary;
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        );
      });

      const [outcome] = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("r1d_registry"),
            modelCallId: context.modelCallId,
            ordinal: 1,
            toolName: "test.side_effect",
            rawArguments: { path: "original.txt" },
          },
        ],
        context,
      );

      expect(outcome!.ok).toBe(true);
      expect(approvalSummary).toBe("original approval summary");
      expect(originalRendererCalls).toBe(1);
      expect(originalExecutorCalls).toBe(1);
      expect(replacementRendererCalls).toBe(0);
      expect(replacementExecutorCalls).toBe(0);
    });
  });

  describe("M3-R2 batch admission and bounded parallelism", () => {
    function r2Context(ids = createSequentialIdFactory()): ToolBatchContext {
      return {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r2"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
    }

    function r2Request(
      context: ToolBatchContext,
      ordinal: number,
      toolName: string,
      path: string,
    ): NormalizedToolRequest {
      return {
        toolCallId: createToolCallId(`r2_${ordinal}_${path}`),
        modelCallId: context.modelCallId,
        ordinal,
        toolName,
        rawArguments: { path },
      };
    }

    function r2Tool({
      name,
      effectClassification = "read-only",
      concurrencyTrait = "parallel-safe",
      approvalSummaryRenderer = () => "r2 approval",
      execute = async (args: Record<string, unknown>) => ({ path: args.path }),
    }: {
      name: string;
      effectClassification?: ToolRegistration["effectClassification"];
      concurrencyTrait?: ToolRegistration["concurrencyTrait"];
      approvalSummaryRenderer?: ToolRegistration["approvalSummaryRenderer"];
      execute?: ToolRegistration["execute"];
    }): ToolRegistration {
      return {
        name,
        descriptorVersion: "1",
        owningModule: "test",
        description: name,
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ path: Type.String() }),
        effectClassification,
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait,
        idempotencyTrait: effectClassification === "read-only",
        approvalSummaryRenderer,
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1",
        execute,
      };
    }

    function allowedPolicy(args: Record<string, unknown>) {
      return {
        decision: "allow",
        reason: "allowed",
        policyProfile: "r2",
        policyVersion: "1",
        targetPath: args.path as string,
        policyConstraints: {},
        redactionMetadata: {},
      };
    }

    it.each([
      ["decision", "allow"],
      ["policyProfile", "different-profile"],
      ["policyVersion", "different-version"],
      ["reason", "different-reason"],
      ["targetPath", "different-path"],
      ["policyConstraintsDigest", "different-digest"],
      ["redactionMetadataDigest", "different-digest"],
    ])(
      "fails closed when the approved binding %s is substituted",
      async (field, replacement) => {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let executions = 0;
        registry.register(
          r2Tool({
            name: "test.approved",
            effectClassification: "side-effecting",
            concurrencyTrait: "sequential",
            execute: async (args) => {
              executions++;
              return { path: args.path };
            },
          }),
        );
        registry.freeze();
        const approvals = new ApprovalCoordinator(ids);
        const runtime = new ToolRuntime(
          registry,
          {
            evaluateInvocation: async (_tool: ToolDescriptor, args: any) => ({
              ...allowedPolicy(args),
              decision: "require-approval",
              reason: "approval required",
              policyConstraints: { scope: "r2" },
              redactionMetadata: { redact: "path" },
            }),
          } as any,
          approvals,
        );
        const context = r2Context(ids);
        approvals.onRequest((binding) => {
          approvals.resolveApproval(
            binding.approvalId,
            context.runId,
            "allow-once",
          );
        });
        const original = approvals.getBindingByToolCallId.bind(approvals);
        approvals.getBindingByToolCallId = (toolCallId) => {
          const binding = original(toolCallId);
          return binding ? { ...binding, [field]: replacement } : undefined;
        };
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));

        const outcomes = await runtime.executeBatch(
          [r2Request(context, 1, "test.approved", "approved.txt")],
          context,
        );

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ok).toBe(false);
        expect(outcomes[0]!.terminalState).toBe(
          "failed-before-known-side-effect",
        );
        expect(outcomes[0]!.error?.code).toBe("TOOL_APPROVAL_DENIED");
        expect(events).not.toContain("tool.started");
        expect(executions).toBe(0);
      },
    );

    it("normalizes a throwing approval renderer and skips later sequential calls", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let approvalsRequested = 0;
      const executions: string[] = [];
      registry.register(
        r2Tool({
          name: "test.renderer_failure",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          approvalSummaryRenderer: () => {
            throw new Error("renderer failed");
          },
          execute: async (args) => {
            executions.push(args.path as string);
            return { path: args.path };
          },
        }),
      );
      registry.register(
        r2Tool({
          name: "test.later_read",
          execute: async (args) => {
            executions.push(args.path as string);
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      approvals.onRequest(() => approvalsRequested++);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (tool: ToolDescriptor, args: any) =>
            tool.name === "test.renderer_failure"
              ? { ...allowedPolicy(args), decision: "require-approval" }
              : allowedPolicy(args),
        } as any,
        approvals,
      );
      const context = r2Context(ids);
      const batch = runtime.executeBatch(
        [
          r2Request(context, 1, "test.renderer_failure", "A"),
          r2Request(context, 2, "test.later_read", "B"),
          r2Request(context, 3, "test.later_read", "C"),
        ],
        context,
      );
      await expect(batch).resolves.toHaveLength(3);
      const outcomes = await batch;

      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual([
        "r2_1_A",
        "r2_2_B",
        "r2_3_C",
      ]);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "failed-before-known-side-effect",
        normalizedArguments: { path: "A" },
        error: { code: "TOOL_IMPLEMENTATION_FAILED" },
      });
      expect(outcomes.slice(1).map((outcome) => outcome.terminalState)).toEqual(
        ["not-started", "not-started"],
      );
      expect(approvalsRequested).toBe(0);
      expect(executions).toEqual([]);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        3,
      );
    });

    it("holds all implementation I/O and planning until every admission phase completes", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      const starts: string[] = [];
      const executionContexts: ToolExecutionContext[] = [];
      registry.register(
        r2Tool({
          name: "test.admission_read",
          execute: async (args, context) => {
            starts.push(args.path as string);
            executionContexts.push(context);
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      let releaseSecondPolicy!: () => void;
      let secondPolicyEntered!: () => void;
      const secondPolicy = new Promise<void>((resolve) => {
        releaseSecondPolicy = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        secondPolicyEntered = resolve;
      });
      const admissions: string[] = [];
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) => {
            admissions.push(args.path);
            if (args.path === "B") {
              secondPolicyEntered();
              await secondPolicy;
            }
            return allowedPolicy(args);
          },
        } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const result = runtime.executeBatch(
        [
          r2Request(context, 1, "test.admission_read", "A"),
          r2Request(context, 2, "test.admission_read", "B"),
          r2Request(context, 3, "test.admission_read", "C"),
        ],
        context,
      );

      await entered;
      expect(admissions).toEqual(["A", "B"]);
      expect(starts).toEqual([]);
      expect(events).not.toContain("tool.batch.planned");
      releaseSecondPolicy();
      await result;
      expect(admissions).toEqual(["A", "B", "C"]);
      expect(starts).toEqual(["A", "B", "C"]);
      expect(executionContexts.map((context) => context.targetPath)).toEqual([
        "A",
        "B",
        "C",
      ]);
    });

    it.each([
      ["mixed read-only and side-effecting", "mixed"],
      ["invalid arguments", "invalid"],
      ["unknown tool", "unknown"],
      ["approval-gated call", "approval"],
      ["non-parallel-safe call", "nonparallel"],
      ["policy-denied call", "denied"],
    ])("uses the sequential fallback for %s", async (_label, kind) => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let active = 0;
      let peak = 0;
      const starts: string[] = [];
      const execute = async (args: Record<string, unknown>) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(args.path as string);
        await Promise.resolve();
        active--;
        return { path: args.path };
      };
      registry.register(r2Tool({ name: "test.safe", execute }));
      registry.register(
        r2Tool({
          name: "test.side",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          execute,
        }),
      );
      registry.register(
        r2Tool({
          name: "test.sequential",
          concurrencyTrait: "sequential",
          execute,
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const context = r2Context(ids);
      approvals.onRequest((binding) => {
        approvals.resolveApproval(
          binding.approvalId,
          context.runId,
          "allow-once",
        );
      });
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (tool: ToolDescriptor, args: any) => {
            if (kind === "denied") {
              return { ...allowedPolicy(args), decision: "deny" };
            }
            if (tool.name === "test.side") {
              return { ...allowedPolicy(args), decision: "require-approval" };
            }
            return allowedPolicy(args);
          },
        } as any,
        approvals,
      );
      const events: Array<{ type: string; data?: Record<string, unknown> }> =
        [];
      runtime.onEvent((event) => events.push(event));
      const requests =
        kind === "mixed"
          ? [
              r2Request(context, 1, "test.safe", "A"),
              r2Request(context, 2, "test.side", "B"),
            ]
          : kind === "invalid"
            ? [
                r2Request(context, 1, "test.safe", "A"),
                {
                  ...r2Request(context, 2, "test.safe", "B"),
                  rawArguments: {},
                },
              ]
            : kind === "unknown"
              ? [
                  r2Request(context, 1, "test.safe", "A"),
                  r2Request(context, 2, "test.unknown", "B"),
                ]
              : kind === "approval"
                ? [r2Request(context, 1, "test.side", "A")]
                : kind === "nonparallel"
                  ? [r2Request(context, 1, "test.sequential", "A")]
                  : [r2Request(context, 1, "test.safe", "A")];

      const outcomes = await runtime.executeBatch(requests, context);

      expect(
        events.find((event) => event.type === "tool.batch.planned")?.data,
      ).toMatchObject({ schedule: "sequential" });
      expect(peak).toBeLessThanOrEqual(1);
      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
      expect(outcomes).toHaveLength(requests.length);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        requests.length,
      );
      if (["invalid", "unknown", "denied"].includes(kind)) {
        expect(outcomes.at(-1)!.ok).toBe(false);
      }
      if (kind === "denied") {
        expect(starts).toEqual([]);
      }
    });

    it("returns original ordinal, id, and payload order after controlled parallel completion", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      const releases = new Map<string, () => void>();
      const entered: Array<() => void> = [];
      registry.register(
        r2Tool({
          name: "test.ordered_read",
          execute: async (args) => {
            entered.shift()?.();
            await new Promise<void>((resolve) =>
              releases.set(args.path as string, resolve),
            );
            return { path: `result-${args.path}` };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
            allowedPolicy(args),
        } as any,
        new ApprovalCoordinator(ids),
        { maxConcurrentToolCalls: 3 },
      );
      const context = r2Context(ids);
      const requests = ["A", "B", "C"].map((path, index) =>
        r2Request(context, index + 1, "test.ordered_read", path),
      );
      const allStarted = new Promise<void>((resolve) => {
        entered.push(
          () => {},
          () => {},
          resolve,
        );
      });
      const batch = runtime.executeBatch(requests, context);
      await allStarted;
      releases.get("C")!();
      await Promise.resolve();
      releases.get("A")!();
      await Promise.resolve();
      releases.get("B")!();
      const outcomes = await batch;

      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
      expect(outcomes.map((outcome) => outcome.ordinal)).toEqual([1, 2, 3]);
      expect(outcomes.map((outcome) => outcome.result)).toEqual([
        { path: "result-A" },
        { path: "result-B" },
        { path: "result-C" },
      ]);
    });

    it("returns one terminal outcome per cancelled request without implementation I/O", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register(
        r2Tool({
          name: "test.cancelled_read",
          execute: async (args) => {
            executions++;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) =>
            allowedPolicy(args),
        } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const controller = new AbortController();
      controller.abort();
      const requests = ["A", "B", "C"].map((path, index) =>
        r2Request(context, index + 1, "test.cancelled_read", path),
      );
      const outcomes = await runtime.executeBatch(
        requests,
        context,
        controller.signal,
      );

      expect(outcomes).toHaveLength(3);
      expect(new Set(outcomes.map((outcome) => outcome.toolCallId)).size).toBe(
        3,
      );
      expect(outcomes.map((outcome) => outcome.terminalState)).toEqual([
        "cancelled-with-no-known-side-effect",
        "cancelled-with-no-known-side-effect",
        "cancelled-with-no-known-side-effect",
      ]);
      expect(executions).toBe(0);
    });

    it("aborts the active invocation signal on parent cancellation and suppresses late success", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let receivedSignal: AbortSignal | undefined;
      let releaseSuccess!: () => void;
      let successPathExecuted = false;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled!: () => void;
      const cancelledPromise = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const successBarrier = new Promise<void>((resolve) => {
        releaseSuccess = resolve;
      });
      registry.register(
        r2Tool({
          name: "test.abort_aware_read",
          execute: async (args, context) => {
            receivedSignal = context.signal;
            context.markIoStarted();
            started();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                cancelled();
                reject(context.signal?.reason);
              };
              context.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
              successBarrier.then(() => {
                context.signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            successPathExecuted = true;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const runtime = new ToolRuntime(
        registry,
        { evaluateInvocation: async (_tool: ToolDescriptor, args: any) => allowedPolicy(args) } as any,
        new ApprovalCoordinator(ids),
      );
      const context = r2Context(ids);
      const controller = new AbortController();
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const execution = runtime.executeBatch(
        [r2Request(context, 1, "test.abort_aware_read", "A")],
        context,
        controller.signal,
      );

      await startedPromise;
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).not.toBe(controller.signal);
      controller.abort();
      await cancelledPromise;
      const outcomes = await execution;
      releaseSuccess();
      await Promise.resolve();

      expect(receivedSignal?.aborted).toBe(true);
      expect(successPathExecuted).toBe(false);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "cancelled-with-no-known-side-effect",
        error: { code: "TOOL_CANCELLED" },
      });
      expect(events.filter((event) => event === "tool.cancelled")).toHaveLength(1);
      expect(events.filter((event) => event === "tool.completed")).toHaveLength(0);
    });

    it("keeps started side-effecting cancellation outcome-uncertain", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let receivedSignal: AbortSignal | undefined;
      let releaseSuccess!: () => void;
      let successPathExecuted = false;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled!: () => void;
      const cancelledPromise = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const successBarrier = new Promise<void>((resolve) => {
        releaseSuccess = resolve;
      });
      registry.register(
        r2Tool({
          name: "test.abort_aware_side_effect",
          effectClassification: "side-effecting",
          concurrencyTrait: "sequential",
          execute: async (args, context) => {
            receivedSignal = context.signal;
            context.markIoStarted();
            context.markSideEffectPossible();
            started();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                cancelled();
                reject(context.signal?.reason);
              };
              context.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
              successBarrier.then(() => {
                context.signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            successPathExecuted = true;
            return { path: args.path };
          },
        }),
      );
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(
        registry,
        {
          evaluateInvocation: async (_tool: ToolDescriptor, args: any) => ({
            ...allowedPolicy(args),
            decision: "require-approval",
          }),
        } as any,
        approvals,
      );
      const context = r2Context(ids);
      approvals.onRequest((binding) => {
        approvals.resolveApproval(binding.approvalId, context.runId, "allow-once");
      });
      const controller = new AbortController();
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));
      const execution = runtime.executeBatch(
        [r2Request(context, 1, "test.abort_aware_side_effect", "A")],
        context,
        controller.signal,
      );

      await startedPromise;
      expect(events).toContain("tool.started");
      controller.abort();
      await cancelledPromise;
      const outcomes = await execution;
      releaseSuccess();
      await Promise.resolve();

      expect(receivedSignal?.aborted).toBe(true);
      expect(successPathExecuted).toBe(false);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        terminalState: "outcome-uncertain",
        error: {
          code: "TOOL_OUTCOME_UNCERTAIN",
          causeCode: "TOOL_CANCELLED",
        },
      });
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events.filter((event) => event === "tool.cancelled")).toHaveLength(0);
      expect(events.filter((event) => event === "tool.completed")).toHaveLength(0);
    });

    it("aborts the active invocation signal on timeout and suppresses late success", async () => {
      vi.useFakeTimers();
      try {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let receivedSignal: AbortSignal | undefined;
        let releaseSuccess!: () => void;
        let successPathExecuted = false;
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        });
        let cancelled!: () => void;
        const cancelledPromise = new Promise<void>((resolve) => {
          cancelled = resolve;
        });
        const successBarrier = new Promise<void>((resolve) => {
          releaseSuccess = resolve;
        });
        registry.register({
          ...r2Tool({
            name: "test.timeout_aware_read",
            execute: async (args, context) => {
              receivedSignal = context.signal;
              started();
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  cancelled();
                  reject(context.signal?.reason);
                };
                context.signal?.addEventListener("abort", onAbort, {
                  once: true,
                });
                successBarrier.then(() => {
                  context.signal?.removeEventListener("abort", onAbort);
                  resolve();
                });
              });
              successPathExecuted = true;
              return { path: args.path };
            },
          }),
          timeoutMs: 25,
        });
        registry.freeze();
        const runtime = new ToolRuntime(
          registry,
          { evaluateInvocation: async (_tool: ToolDescriptor, args: any) => allowedPolicy(args) } as any,
          new ApprovalCoordinator(ids),
          { toolTimeoutMs: 25 },
        );
        const context = r2Context(ids);
        const events: string[] = [];
        runtime.onEvent((event) => events.push(event.type));
        const execution = runtime.executeBatch(
          [r2Request(context, 1, "test.timeout_aware_read", "A")],
          context,
        );

        await startedPromise;
        await vi.advanceTimersByTimeAsync(25);
        await cancelledPromise;
        const outcomes = await execution;
        releaseSuccess();
        await Promise.resolve();

        expect(receivedSignal?.aborted).toBe(true);
        expect(successPathExecuted).toBe(false);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          ok: false,
          terminalState: "failed-before-known-side-effect",
          error: { code: "TOOL_EXECUTION_TIMEOUT" },
        });
        expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
        expect(events.filter((event) => event === "tool.completed")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("admits the whole batch before bounded read implementations start and preserves request order", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let active = 0;
      let peak = 0;
      const starts: string[] = [];
      const releases = new Map<string, () => void>();
      const entered: Array<() => void> = [];
      registry.register({
        name: "test.read",
        descriptorVersion: "1",
        owningModule: "test",
        description: "barrier read",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ path: Type.String() }),
        effectClassification: "read-only",
        sensitivityClassification: "none",
        executionTarget: "workspace",
        sandboxRequirement: "host-workspace-v1",
        timeoutMs: 5000,
        cancellationSupport: true,
        concurrencyTrait: "parallel-safe",
        idempotencyTrait: true,
        approvalSummaryRenderer: () => "read",
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1",
        execute: async (args) => {
          active++;
          peak = Math.max(peak, active);
          starts.push(args.path as string);
          entered.shift()?.();
          await new Promise<void>((resolve) =>
            releases.set(args.path as string, resolve),
          );
          active--;
          return { path: args.path };
        },
      });
      registry.freeze();
      const policy = {
        evaluateInvocation: async (
          _tool: ToolDescriptor,
          args: Record<string, unknown>,
        ) => ({
          decision: "allow",
          reason: "allowed",
          policyProfile: "test",
          policyVersion: "1",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;
      const runtime = new ToolRuntime(
        registry,
        policy,
        new ApprovalCoordinator(ids),
        {
          maxConcurrentToolCalls: 2,
        },
      );
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:r2"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: process.cwd(),
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };
      const requests = ["A", "B", "C"].map((path, index) => ({
        toolCallId: createToolCallId(`r2_${path}`),
        modelCallId: context.modelCallId,
        ordinal: index + 1,
        toolName: "test.read",
        rawArguments: { path },
      }));
      const twoStarted = new Promise<void>((resolve) => {
        entered.push(() => {}, resolve);
      });
      const result = runtime.executeBatch(requests, context);
      await twoStarted;
      expect(starts).toHaveLength(2);
      expect(peak).toBe(2);
      releases.get("B")!();
      await new Promise<void>((resolve) => entered.push(resolve));
      expect(starts).toHaveLength(3);
      expect(peak).toBe(2);
      releases.get("A")!();
      releases.get("C")!();
      expect((await result).map((outcome) => outcome.toolCallId)).toEqual(
        requests.map((request) => request.toolCallId),
      );
    });
  });

  describe("M3-R3-4 certainty evidence", () => {
    function writeRuntime(filesystem: WorkspaceFilesystem, ids = createSequentialIdFactory(), hooks?: import("./tool-runtime.js").ToolRuntimeTestHooks) {
      const registry = new ToolRegistry();
      registry.register(createWorkspaceWriteTextTool(filesystem));
      registry.freeze();
      const approvals = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(registry, new WorkspacePolicy(filesystem), approvals, undefined, hooks);
      const context: ToolBatchContext = {
        agentId: createAgentId("primary"), sessionKey: createSessionKey("agent:primary:r34"),
        sessionId: ids.nextSessionId(), runId: ids.nextRunId(), attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(), workspaceRoot: "/workspace", sandboxProfile: "host-workspace-v1", totalRunToolCalls: 0,
      };
      approvals.onRequest((binding) => approvals.resolveApproval(binding.approvalId, context.runId, "allow-once"));
      return { runtime, context };
    }

    it("G1 forces only the selected admitted invocation through the missing execution-context fallback", async () => {
      let executions = 0;
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined, list: async () => [],
        readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
        inspectTextForWrite: async () => ({ priorState: "none" }),
        createText: async () => { executions++; }, writeText: async () => { executions++; },
      };
      const selected = createToolCallId("r34_missing_context");
      const { runtime, context } = writeRuntime(filesystem, createSequentialIdFactory(), {
        forceMissingExecutionContext: (toolCallId) => toolCallId === selected,
      });
      const events: Array<{ type: string; toolCallId?: string; data?: Record<string, unknown> }> = [];
      runtime.onEvent((event) => events.push(event));
      const [outcome] = await runtime.executeBatch([{ toolCallId: selected, modelCallId: context.modelCallId, ordinal: 1, toolName: "workspace.write_text", rawArguments: { path: "a.txt", content: "x", mode: "create" } }], context);
      expect(executions).toBe(0);
      expect(outcome).toMatchObject({ terminalState: "failed-before-known-side-effect", normalizedArguments: { path: "a.txt", content: "x", mode: "create" }, error: { code: "TOOL_IMPLEMENTATION_FAILED" } });
      expect(events.filter((event) => ["tool.failed", "tool.started", "tool.completed", "tool.cancelled"].includes(event.type))).toEqual([
        expect.objectContaining({ type: "tool.failed", toolCallId: selected, data: expect.objectContaining({ code: "TOOL_IMPLEMENTATION_FAILED" }) }),
      ]);
    });

    it("G3 classifies production workspace inspection failure before the possible-effect marker", async () => {
      const calls: string[] = [];
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined, list: async () => [],
        readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
        inspectTextForWrite: async () => { calls.push("inspect"); throw new AppError("TOOL_IMPLEMENTATION_FAILED", "inspection failed"); },
        createText: async () => { calls.push("create"); }, writeText: async () => { calls.push("write"); },
      };
      const { runtime, context } = writeRuntime(filesystem);
      const events: string[] = []; runtime.onEvent((event) => events.push(event.type));
      const [outcome] = await runtime.executeBatch([{ toolCallId: createToolCallId("r34_g3"), modelCallId: context.modelCallId, ordinal: 1, toolName: "workspace.write_text", rawArguments: { path: "a.txt", content: "x", mode: "write" } }], context);
      expect(calls).toEqual(["inspect"]);
      expect(outcome).toMatchObject({ terminalState: "failed-before-known-side-effect", error: { code: "TOOL_IMPLEMENTATION_FAILED" } });
      expect(events.filter((event) => event === "tool.started")).toHaveLength(1);
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events).not.toContain("tool.completed");
    });

    it("G4 classifies production workspace mutation failure as uncertain with a safe cause", async () => {
      let effects = 0;
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined, list: async () => [],
        readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
        inspectTextForWrite: async () => ({ priorState: "none" }),
        createText: async () => { effects++; throw new AppError("TOOL_IMPLEMENTATION_FAILED", "write failed"); },
        writeText: async () => { effects++; throw new AppError("TOOL_IMPLEMENTATION_FAILED", "write failed"); },
      };
      const { runtime, context } = writeRuntime(filesystem);
      const events: string[] = []; runtime.onEvent((event) => events.push(event.type));
      const [outcome] = await runtime.executeBatch([{ toolCallId: createToolCallId("r34_g4"), modelCallId: context.modelCallId, ordinal: 1, toolName: "workspace.write_text", rawArguments: { path: "a.txt", content: "x", mode: "create" } }], context);
      expect(effects).toBe(1);
      expect(outcome).toMatchObject({ terminalState: "outcome-uncertain", error: { code: "TOOL_OUTCOME_UNCERTAIN", causeCode: "TOOL_IMPLEMENTATION_FAILED" } });
      expect(events.filter((event) => event === "tool.failed")).toHaveLength(1);
      expect(events).not.toContain("tool.completed");
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
            ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({ type: "tool.failed", toolCallId: "tcall_g1_invalid" }),
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
            ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({ type: "tool.failed", toolCallId: "tcall_g1_policy" }),
        ]);
      });

      it("handles approval denial before I/O or start", async () => {
        let executions = 0;
        let fsCalls = 0;
        const ids = createSequentialIdFactory();
        const filesystem: WorkspaceFilesystem = {
          preflight: async () => undefined,
          list: async () => [],
          readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
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
            ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({ type: "tool.failed", toolCallId: "tcall_g1_appr_deny" }),
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
            readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
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
              ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
            ),
          ).toEqual([
            expect.objectContaining({ type: "tool.failed", toolCallId: "tcall_g1_exp" }),
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
          readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
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
            ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({ type: "tool.cancelled", toolCallId: "tcall_g1_cancel" }),
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
            ["tool.started", "tool.completed", "tool.failed", "tool.cancelled"].includes(e.type),
          ),
        ).toEqual([
          expect.objectContaining({ type: "tool.cancelled", toolCallId: "tcall_g1_aborted" }),
        ]);
      });
    });

    describe("G5 post-effect cancellation", () => {
      it("classifies post-side-effect parent cancellation as outcome-uncertain", async () => {
        let executions = 0;
        let effectCount = 0;
        const parentController = new AbortController();
        let childAbortedInImpl = false;

        const registry = new ToolRegistry();
        registry.register({
          name: "test.write_side_effect",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "side effect tool",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            executions++;
            context.markIoStarted();
            context.markSideEffectPossible();
            effectCount++;
            parentController.abort();
            childAbortedInImpl = Boolean(context.signal?.aborted);
            throw new Error("interrupted side effect");
          },
        });
        registry.freeze();

        const ids = createSequentialIdFactory();
        const approvals = new ApprovalCoordinator(ids);
        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(registry, policy, approvals);
        const context: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g5"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest((binding) =>
          approvals.resolveApproval(binding.approvalId, context.runId, "allow-once"),
        );

        const events: string[] = [];
        runtime.onEvent((e) => events.push(e.type));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g5"),
              modelCallId: context.modelCallId,
              ordinal: 1,
              toolName: "test.write_side_effect",
              rawArguments: { path: "a.txt" },
            },
          ],
          context,
          parentController.signal,
        );

        expect(executions).toBe(1);
        expect(effectCount).toBe(1);
        expect(childAbortedInImpl).toBe(true);
        expect(outcome).toMatchObject({
          terminalState: "outcome-uncertain",
          error: {
            code: "TOOL_OUTCOME_UNCERTAIN",
            causeCode: "TOOL_CANCELLED",
          },
        });
        expect(events.filter((t) => t === "tool.failed")).toHaveLength(1);
        expect(events.filter((t) => t === "tool.cancelled")).toHaveLength(0);
        expect(events.filter((t) => t === "tool.completed")).toHaveLength(0);
      });
    });

    describe("G6 post-effect timeout", () => {
      it("classifies post-side-effect timeout as outcome-uncertain using fake timers", async () => {
        vi.useFakeTimers();
        try {
          let executions = 0;
          let effectCount = 0;
          let childAbortedInImpl = false;

          const registry = new ToolRegistry();
          registry.register({
            name: "test.timeout_side_effect",
            descriptorVersion: "1.0.0",
            owningModule: "test",
            description: "timeout side effect tool",
            argumentSchema: Type.Object({ path: Type.String() }),
            resultSchema: Type.Object({ ok: Type.Boolean() }),
            effectClassification: "side-effecting",
            sensitivityClassification: "none",
            executionTarget: "workspace",
            sandboxRequirement: "host-workspace-v1",
            timeoutMs: 1000,
            cancellationSupport: true,
            concurrencyTrait: "sequential",
            idempotencyTrait: false,
            approvalSummaryRenderer: () => "timeout write",
            redactionRules: [],
            inputLimits: {},
            outputLimits: {},
            progressFingerprintVersion: "1.0.0",
            execute: async (_args, context) => {
              executions++;
              context.markIoStarted();
              context.markSideEffectPossible();
              effectCount++;
              vi.advanceTimersByTime(2000);
              childAbortedInImpl = Boolean(context.signal?.aborted);
              throw new Error("timed out side effect");
            },
          });
          registry.freeze();

          const ids = createSequentialIdFactory();
          const approvals = new ApprovalCoordinator(ids);
          const policy = {
            evaluateInvocation: async (_t: any, args: any) => ({
              decision: "require-approval",
              reason: "approval required",
              policyProfile: "test",
              policyVersion: "1.0.0",
              targetPath: args.path,
              policyConstraints: {},
              redactionMetadata: {},
            }),
          } as any;
          const runtime = new ToolRuntime(registry, policy, approvals, {
            toolTimeoutMs: 1000,
          });
          const context: ToolBatchContext = {
            agentId: createAgentId("primary"),
            sessionKey: createSessionKey("agent:primary:g6"),
            sessionId: ids.nextSessionId(),
            runId: ids.nextRunId(),
            attemptId: ids.nextAttemptId(),
            modelCallId: ids.nextModelCallId(),
            workspaceRoot: "/workspace",
            sandboxProfile: "host-workspace-v1",
            totalRunToolCalls: 0,
          };
          approvals.onRequest((binding) =>
            approvals.resolveApproval(binding.approvalId, context.runId, "allow-once"),
          );

          const events: string[] = [];
          runtime.onEvent((e) => events.push(e.type));

          const [outcome] = await runtime.executeBatch(
            [
              {
                toolCallId: createToolCallId("tcall_g6"),
                modelCallId: context.modelCallId,
                ordinal: 1,
                toolName: "test.timeout_side_effect",
                rawArguments: { path: "a.txt" },
              },
            ],
            context,
          );

          expect(executions).toBe(1);
          expect(effectCount).toBe(1);
          expect(childAbortedInImpl).toBe(true);
          expect(outcome).toMatchObject({
            terminalState: "outcome-uncertain",
            error: {
              code: "TOOL_OUTCOME_UNCERTAIN",
              causeCode: "TOOL_EXECUTION_TIMEOUT",
            },
          });
          expect(events.filter((t) => t === "tool.failed")).toHaveLength(1);
          expect(events.filter((t) => t === "tool.completed")).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("G7 race matrix", () => {
      it("ensures exactly one terminal outcome and event across cancellation, timeout, and late markers", async () => {
        const ids = createSequentialIdFactory();
        let lateContext: ToolExecutionContext | undefined;
        const registry = new ToolRegistry();
        registry.register({
          name: "test.late_markers",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "test late markers",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "read-only",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "parallel-safe",
          idempotencyTrait: true,
          approvalSummaryRenderer: () => "read",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            context.markIoStarted();
            lateContext = context;
            return { ok: true };
          },
        });
        registry.freeze();

        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "allow",
            reason: "allowed",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(registry, policy, new ApprovalCoordinator(ids));
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g7"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };

        const events: string[] = [];
        runtime.onEvent((e) => events.push(e.type));

        const [outcome] = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_late"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.late_markers",
              rawArguments: { path: "a.txt" },
            },
          ],
          batchContext,
        );

        expect(outcome?.ok).toBe(true);
        const eventCountBeforeLate = events.length;
        const terminalEventsBeforeLate = events.filter((t) =>
          ["tool.completed", "tool.failed", "tool.cancelled"].includes(t),
        );
        expect(terminalEventsBeforeLate).toHaveLength(1);

        lateContext?.markIoStarted();
        lateContext?.markSideEffectPossible();

        expect(events.length).toBe(eventCountBeforeLate);
        const terminalEventsAfterLate = events.filter((t) =>
          ["tool.completed", "tool.failed", "tool.cancelled"].includes(t),
        );
        expect(terminalEventsAfterLate).toHaveLength(1);
      });
    });

    describe("G8 no automatic replay batch proof", () => {
      it("halts sequential execution after uncertain side-effect failure without invoking remaining batch tools", async () => {
        const ids = createSequentialIdFactory();
        let firstExecutions = 0;
        let secondExecutions = 0;
        let firstEffects = 0;

        const registry = new ToolRegistry();
        registry.register({
          name: "test.write_uncertain_1",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "write uncertain 1",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write 1",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            firstExecutions++;
            context.markIoStarted();
            context.markSideEffectPossible();
            firstEffects++;
            throw new Error("uncertain write failure");
          },
        });
        registry.register({
          name: "test.write_uncertain_2",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "write uncertain 2",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "workspace",
          sandboxRequirement: "host-workspace-v1",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          approvalSummaryRenderer: () => "write 2",
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          execute: async (_args, context) => {
            secondExecutions++;
            context.markIoStarted();
            return { ok: true };
          },
        });
        registry.freeze();

        const approvals = new ApprovalCoordinator(ids);
        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;
        const runtime = new ToolRuntime(registry, policy, approvals);
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g8_batch"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };
        approvals.onRequest((binding) =>
          approvals.resolveApproval(binding.approvalId, batchContext.runId, "allow-once"),
        );

        const outcomes = await runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g8_1"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.write_uncertain_1",
              rawArguments: { path: "1.txt" },
            },
            {
              toolCallId: createToolCallId("tcall_g8_2"),
              modelCallId: batchContext.modelCallId,
              ordinal: 2,
              toolName: "test.write_uncertain_2",
              rawArguments: { path: "2.txt" },
            },
          ],
          batchContext,
        );

        expect(firstExecutions).toBe(1);
        expect(firstEffects).toBe(1);
        expect(secondExecutions).toBe(0);
        expect(outcomes[0]!.terminalState).toBe("outcome-uncertain");
        expect(outcomes[1]!.terminalState).toBe("not-started");
      });
    });
  });

  describe("G2 — Runtime marker authority", () => {
    it("G2 emits tool.started only on the first accepted I/O marker and ignores duplicate or late markers", async () => {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let startedCount = 0;
      let capturedContext: ToolExecutionContext | undefined;

      const g2Tool: ToolRegistration<{ path: string }, { ok: boolean }> = {
        name: "test.g2_marker_tool",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "G2 marker test tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ ok: Type.Boolean() }),
        effectClassification: "side-effecting",
        sensitivityClassification: "none",
        executionTarget: "host",
        sandboxRequirement: "none",
        timeoutMs: 30000,
        cancellationSupport: true,
        concurrencyTrait: "sequential",
        idempotencyTrait: false,
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1.0.0",
        approvalSummaryRenderer: () => "G2 test tool summary",
        execute: async (_args, context) => {
          capturedContext = context;
          expect(startedCount).toBe(0);
          context.markIoStarted();
          expect(startedCount).toBe(1);
          context.markIoStarted();
          expect(startedCount).toBe(1);
          context.markSideEffectPossible();
          expect(startedCount).toBe(1);
          return { ok: true };
        },
      };

      registry.register(g2Tool);
      registry.freeze();

      const policy = {
        evaluateInvocation: async (_t: any, args: any) => ({
          decision: "require-approval",
          reason: "approval required",
          policyProfile: "test",
          policyVersion: "1.0.0",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;

      const approvalCoordinator = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:g2_batch"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      approvalCoordinator.onRequest((binding) =>
        approvalCoordinator.resolveApproval(
          binding.approvalId,
          batchContext.runId,
          "allow-once",
        ),
      );

      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      runtime.onEvent((e) => {
        if (e.type === "tool.started") {
          startedCount++;
        }
        events.push(e);
      });

      const outcomes = await runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g2_1"),
            modelCallId: batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g2_marker_tool",
            rawArguments: { path: "test.txt" },
          },
        ],
        batchContext,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("completed");
      expect(outcome.ok).toBe(true);

      const completedEvents = events.filter((e) => e.type === "tool.completed");
      const failedEvents = events.filter((e) => e.type === "tool.failed");
      const cancelledEvents = events.filter((e) => e.type === "tool.cancelled");

      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(cancelledEvents).toHaveLength(0);

      expect(capturedContext).toBeDefined();
      const eventCountBeforeLate = events.length;

      capturedContext!.markIoStarted();
      capturedContext!.markSideEffectPossible();

      expect(events.length).toBe(eventCountBeforeLate);
      expect(startedCount).toBe(1);
      expect(completedEvents).toHaveLength(1);
      expect(outcome.terminalState).toBe("completed");
    });
  });

  describe("G6 — Timeout followed by late successful resolution", () => {
    it("G6 seals an uncertain timeout outcome and suppresses late implementation success", async () => {
      vi.useFakeTimers();
      try {
        const ids = createSequentialIdFactory();
        const registry = new ToolRegistry();
        let executeCount = 0;
        let effectCount = 0;

        function createDeferred<T>() {
          let resolve!: (val: T) => void;
          let reject!: (err: unknown) => void;
          const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
          });
          promise.catch(() => {});
          return { promise, resolve, reject };
        }

        const effectReached = createDeferred<void>();
        const releaseImplementation = createDeferred<{ ok: boolean }>();
        let capturedContext: ToolExecutionContext | undefined;

        const g6Tool: ToolRegistration<{ path: string }, { ok: boolean }> = {
          name: "test.g6_timeout_tool",
          descriptorVersion: "1.0.0",
          owningModule: "test",
          description: "G6 timeout test tool",
          argumentSchema: Type.Object({ path: Type.String() }),
          resultSchema: Type.Object({ ok: Type.Boolean() }),
          effectClassification: "side-effecting",
          sensitivityClassification: "none",
          executionTarget: "host",
          sandboxRequirement: "none",
          timeoutMs: 5000,
          cancellationSupport: true,
          concurrencyTrait: "sequential",
          idempotencyTrait: false,
          redactionRules: [],
          inputLimits: {},
          outputLimits: {},
          progressFingerprintVersion: "1.0.0",
          approvalSummaryRenderer: () => "G6 test tool summary",
          execute: async (_args, context) => {
            capturedContext = context;
            executeCount += 1;
            context.markIoStarted();
            context.markSideEffectPossible();
            effectCount += 1;
            effectReached.resolve();
            return await releaseImplementation.promise;
          },
        };

        registry.register(g6Tool);
        registry.freeze();

        const policy = {
          evaluateInvocation: async (_t: any, args: any) => ({
            decision: "require-approval",
            reason: "approval required",
            policyProfile: "test",
            policyVersion: "1.0.0",
            targetPath: args.path,
            policyConstraints: {},
            redactionMetadata: {},
          }),
        } as any;

        const approvalCoordinator = new ApprovalCoordinator(ids);
        const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
        const batchContext: ToolBatchContext = {
          agentId: createAgentId("primary"),
          sessionKey: createSessionKey("agent:primary:g6_batch"),
          sessionId: ids.nextSessionId(),
          runId: ids.nextRunId(),
          attemptId: ids.nextAttemptId(),
          modelCallId: ids.nextModelCallId(),
          workspaceRoot: "/workspace",
          sandboxProfile: "host-workspace-v1",
          totalRunToolCalls: 0,
        };

        approvalCoordinator.onRequest((binding) =>
          approvalCoordinator.resolveApproval(
            binding.approvalId,
            batchContext.runId,
            "allow-once",
          ),
        );

        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        runtime.onEvent((e) => events.push(e));

        const batchPromise = runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g6_1"),
              modelCallId: batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g6_timeout_tool",
              rawArguments: { path: "test.txt" },
            },
          ],
          batchContext,
        );

        await effectReached.promise;
        await vi.advanceTimersByTimeAsync(5000);

        expect(capturedContext?.signal?.aborted).toBe(true);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;

        expect(executeCount).toBe(1);
        expect(effectCount).toBe(1);
        expect(outcome.terminalState).toBe("outcome-uncertain");
        expect(outcome.error?.code).toBe("TOOL_OUTCOME_UNCERTAIN");
        expect(outcome.error?.causeCode).toBe("TOOL_EXECUTION_TIMEOUT");

        const failedEvents = events.filter((e) => e.type === "tool.failed");
        const completedEvents = events.filter((e) => e.type === "tool.completed");
        const cancelledEvents = events.filter((e) => e.type === "tool.cancelled");

        expect(failedEvents).toHaveLength(1);
        expect(completedEvents).toHaveLength(0);
        expect(cancelledEvents).toHaveLength(0);
        expect(failedEvents.length + completedEvents.length + cancelledEvents.length).toBe(1);

        const eventCountBeforeRelease = events.length;

        releaseImplementation.resolve({ ok: true });
        await vi.runAllTimersAsync();

        expect(executeCount).toBe(1);
        expect(effectCount).toBe(1);
        expect(events.length).toBe(eventCountBeforeRelease);
        expect(events.filter((e) => e.type === "tool.failed")).toHaveLength(1);
        expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(0);
        expect(
          events.filter(
            (e) =>
              e.type === "tool.failed" ||
              e.type === "tool.completed" ||
              e.type === "tool.cancelled",
          ),
        ).toHaveLength(1);
        expect(outcome.terminalState).toBe("outcome-uncertain");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("G7 first-terminal-wins race matrix", () => {
    function createDeferred<T>() {
      let resolve!: (val: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      return { promise, resolve, reject };
    }

    function setupRaceHarness(
      executeFn: (context: ToolExecutionContext) => Promise<{ ok: boolean }>,
      options?: { timeoutMs?: number },
    ) {
      const ids = createSequentialIdFactory();
      const registry = new ToolRegistry();
      let executeCount = 0;
      const implementationEntered = createDeferred<void>();

      const readOnlyTool: ToolRegistration<{ path: string }, { ok: boolean }> = {
        name: "test.g7_race_tool",
        descriptorVersion: "1.0.0",
        owningModule: "test",
        description: "G7 race matrix tool",
        argumentSchema: Type.Object({ path: Type.String() }),
        resultSchema: Type.Object({ ok: Type.Boolean() }),
        effectClassification: "read-only",
        sensitivityClassification: "none",
        executionTarget: "host",
        sandboxRequirement: "none",
        timeoutMs: options?.timeoutMs ?? 5000,
        cancellationSupport: true,
        concurrencyTrait: "parallel-safe",
        idempotencyTrait: true,
        redactionRules: [],
        inputLimits: {},
        outputLimits: {},
        progressFingerprintVersion: "1.0.0",
        approvalSummaryRenderer: () => "G7 race tool summary",
        execute: async (_args, context) => {
          executeCount += 1;
          context.markIoStarted();
          implementationEntered.resolve();
          return await executeFn(context);
        },
      };

      registry.register(readOnlyTool);
      registry.freeze();

      const policy = {
        evaluateInvocation: async (_t: any, args: any) => ({
          decision: "allow",
          reason: "read-only allowed",
          policyProfile: "test",
          policyVersion: "1.0.0",
          targetPath: args.path,
          policyConstraints: {},
          redactionMetadata: {},
        }),
      } as any;

      const approvalCoordinator = new ApprovalCoordinator(ids);
      const runtime = new ToolRuntime(registry, policy, approvalCoordinator);
      const batchContext: ToolBatchContext = {
        agentId: createAgentId("primary"),
        sessionKey: createSessionKey("agent:primary:g7_batch"),
        sessionId: ids.nextSessionId(),
        runId: ids.nextRunId(),
        attemptId: ids.nextAttemptId(),
        modelCallId: ids.nextModelCallId(),
        workspaceRoot: "/workspace",
        sandboxProfile: "host-workspace-v1",
        totalRunToolCalls: 0,
      };

      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      runtime.onEvent((e) => events.push(e));

      return {
        ids,
        runtime,
        batchContext,
        events,
        implementationEntered,
        getExecuteCount: () => executeCount,
      };
    }

    function expectTerminalEvents(events: Array<{ type: string }>) {
      const completed = events.filter((e) => e.type === "tool.completed").length;
      const failed = events.filter((e) => e.type === "tool.failed").length;
      const cancelled = events.filter((e) => e.type === "tool.cancelled").length;
      expect(completed + failed + cancelled).toBe(1);
      return { completed, failed, cancelled };
    }

    it("1. result before parent cancellation", async () => {
      const controller = new AbortController();
      const harness = setupRaceHarness(async () => ({ ok: true }));

      const outcomes = await harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_1"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "1.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("completed");
      expect(outcome.ok).toBe(true);

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.completed).toBe(1);
      expect(terminal.failed).toBe(0);
      expect(terminal.cancelled).toBe(0);

      controller.abort();
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("completed");
    });

    it("2. parent cancellation before late result", async () => {
      const controller = new AbortController();
      const deferred = createDeferred<{ ok: boolean }>();
      const harness = setupRaceHarness(async () => await deferred.promise);

      const batchPromise = harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_2"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "2.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      await harness.implementationEntered.promise;
      expect(harness.getExecuteCount()).toBe(1);
      expect(harness.events.filter((e) => e.type === "tool.started")).toHaveLength(1);

      controller.abort();

      const outcomes = await batchPromise;
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_CANCELLED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.cancelled).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.failed).toBe(0);

      const eventCountBeforeLate = harness.events.length;
      deferred.resolve({ ok: true });
      await Promise.resolve();

      expect(harness.events.length).toBe(eventCountBeforeLate);
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
    });

    it("3. implementation error before parent cancellation", async () => {
      const controller = new AbortController();
      const harness = setupRaceHarness(async () => {
        throw new AppError("TOOL_IMPLEMENTATION_FAILED", "Impl error 3");
      });

      const outcomes = await harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_3"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "3.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_IMPLEMENTATION_FAILED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.failed).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.cancelled).toBe(0);

      controller.abort();
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("failed-before-known-side-effect");
    });

    it("4. parent cancellation before late implementation error", async () => {
      const controller = new AbortController();
      const deferred = createDeferred<{ ok: boolean }>();
      const harness = setupRaceHarness(async () => await deferred.promise);

      const batchPromise = harness.runtime.executeBatch(
        [
          {
            toolCallId: createToolCallId("tcall_g7_4"),
            modelCallId: harness.batchContext.modelCallId,
            ordinal: 1,
            toolName: "test.g7_race_tool",
            rawArguments: { path: "4.txt" },
          },
        ],
        harness.batchContext,
        controller.signal,
      );

      await harness.implementationEntered.promise;
      expect(harness.getExecuteCount()).toBe(1);
      expect(harness.events.filter((e) => e.type === "tool.started")).toHaveLength(1);

      controller.abort();

      const outcomes = await batchPromise;
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe("TOOL_CANCELLED");

      const terminal = expectTerminalEvents(harness.events);
      expect(terminal.cancelled).toBe(1);
      expect(terminal.completed).toBe(0);
      expect(terminal.failed).toBe(0);

      const eventCountBeforeLate = harness.events.length;
      deferred.reject(new Error("Late error 4"));
      await Promise.resolve();

      expect(harness.events.length).toBe(eventCountBeforeLate);
      expectTerminalEvents(harness.events);
      expect(outcome.terminalState).toBe("cancelled-with-no-known-side-effect");
    });

    it("5. result before timeout", async () => {
      vi.useFakeTimers();
      try {
        const harness = setupRaceHarness(async () => ({ ok: true }), {
          timeoutMs: 5000,
        });

        const outcomes = await harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_5"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "5.txt" },
            },
          ],
          harness.batchContext,
        );

        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("completed");
        expect(outcome.ok).toBe(true);

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.completed).toBe(1);
        expect(terminal.failed).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);

        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("completed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("6. timeout before late result", async () => {
      vi.useFakeTimers();
      try {
        const deferred = createDeferred<{ ok: boolean }>();
        const harness = setupRaceHarness(async () => await deferred.promise, {
          timeoutMs: 5000,
        });

        const batchPromise = harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_6"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "6.txt" },
            },
          ],
          harness.batchContext,
        );

        await harness.implementationEntered.promise;
        expect(harness.getExecuteCount()).toBe(1);
        expect(harness.events.filter((e) => e.type === "tool.started")).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(5000);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_EXECUTION_TIMEOUT");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        const eventCountBeforeLate = harness.events.length;
        deferred.resolve({ ok: true });
        await vi.runAllTimersAsync();

        expect(harness.events.length).toBe(eventCountBeforeLate);
        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });

    it("7. implementation error before timeout", async () => {
      vi.useFakeTimers();
      try {
        const harness = setupRaceHarness(
          async () => {
            throw new AppError("TOOL_IMPLEMENTATION_FAILED", "Impl error 7");
          },
          { timeoutMs: 5000 },
        );

        const outcomes = await harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_7"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "7.txt" },
            },
          ],
          harness.batchContext,
        );

        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_IMPLEMENTATION_FAILED");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);

        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });

    it("8. timeout before late implementation error", async () => {
      vi.useFakeTimers();
      try {
        const deferred = createDeferred<{ ok: boolean }>();
        const harness = setupRaceHarness(async () => await deferred.promise, {
          timeoutMs: 5000,
        });

        const batchPromise = harness.runtime.executeBatch(
          [
            {
              toolCallId: createToolCallId("tcall_g7_8"),
              modelCallId: harness.batchContext.modelCallId,
              ordinal: 1,
              toolName: "test.g7_race_tool",
              rawArguments: { path: "8.txt" },
            },
          ],
          harness.batchContext,
        );

        await harness.implementationEntered.promise;
        expect(harness.getExecuteCount()).toBe(1);
        expect(harness.events.filter((e) => e.type === "tool.started")).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(5000);

        const outcomes = await batchPromise;
        expect(outcomes).toHaveLength(1);
        const outcome = outcomes[0]!;
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error?.code).toBe("TOOL_EXECUTION_TIMEOUT");

        const terminal = expectTerminalEvents(harness.events);
        expect(terminal.failed).toBe(1);
        expect(terminal.completed).toBe(0);

        const eventCountBeforeLate = harness.events.length;
        deferred.reject(new Error("Late error 8"));
        await vi.runAllTimersAsync();

        expect(harness.events.length).toBe(eventCountBeforeLate);
        expectTerminalEvents(harness.events);
        expect(outcome.terminalState).toBe("failed-before-known-side-effect");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});


