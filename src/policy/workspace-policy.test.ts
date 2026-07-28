import * as fs from "node:fs";
import * as joinPath from "node:path";
import { describe, expect, it } from "vitest";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";
import {
  workspaceListTool,
  workspaceWriteTextTool,
} from "../tools/workspace-tools.js";
import { WorkspacePolicy } from "./workspace-policy.js";

describe("WorkspacePolicy", () => {
  it("computes deterministic fingerprint", () => {
    const policy = new WorkspacePolicy();
    expect(policy.computeFingerprint()).toHaveLength(64);
  });

  it("evaluates visibility correctly", () => {
    const policy = new WorkspacePolicy();
    const visible = policy.evaluateVisibility([
      workspaceListTool,
      workspaceWriteTextTool,
    ]);
    expect(visible).toHaveLength(2);
  });

  it("permits safe read-only paths and denies escapes", async () => {
    const { path: tempDir, close } = createTemporaryDatabase();
    const workspaceRoot = joinPath.dirname(tempDir);
    const policy = new WorkspacePolicy();

    const allowRes = await policy.evaluateInvocation(
      workspaceListTool,
      { path: "sub" },
      workspaceRoot,
    );
    expect(allowRes.decision).toBe("allow");

    const traversalRes = await policy.evaluateInvocation(
      workspaceListTool,
      { path: "../outside" },
      workspaceRoot,
    );
    expect(traversalRes.decision).toBe("deny");

    const protectedRes = await policy.evaluateInvocation(
      workspaceListTool,
      { path: ".env" },
      workspaceRoot,
    );
    expect(protectedRes.decision).toBe("deny");

    close();
  });

  it("requires approval for workspace.write_text on safe paths", async () => {
    const { path: tempDir, close } = createTemporaryDatabase();
    const workspaceRoot = joinPath.dirname(tempDir);
    const policy = new WorkspacePolicy();

    const res = await policy.evaluateInvocation(
      workspaceWriteTextTool,
      { path: "test.txt", content: "hello", mode: "create" },
      workspaceRoot,
    );
    expect(res.decision).toBe("require-approval");

    close();
  });
});
