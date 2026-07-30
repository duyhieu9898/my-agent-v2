import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentId, createSessionKey } from "../core/identities.js";
import { ApprovalCoordinator } from "../policy/approval-coordinator.js";
import { WorkspacePolicy } from "../policy/workspace-policy.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import { createSequentialIdFactory } from "../test/foundation-fixtures.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolRuntime, type ToolBatchContext } from "./tool-runtime.js";
import {
  createWorkspaceListTool,
  createWorkspaceReadTextTool,
  createWorkspaceWriteTextTool,
} from "./workspace-tools.js";

export function createTempWorkspace() {
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

export function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function setupTestRuntime(customWorkspaceRoot?: string) {
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
