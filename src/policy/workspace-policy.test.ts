import * as fs from "node:fs";
import * as os from "node:os";
import * as joinPath from "node:path";
import { describe, expect, it } from "vitest";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";
import {
  createWorkspaceListTool,
  createWorkspaceWriteTextTool,
} from "../tools/workspace-tools.js";
import { WorkspacePolicy } from "./workspace-policy.js";

function setupWorkspacePolicy() {
  const workspaceFilesystem = new FsSafeWorkspaceFilesystem();
  return {
    policy: new WorkspacePolicy(workspaceFilesystem),
    workspaceListTool: createWorkspaceListTool(workspaceFilesystem),
    workspaceWriteTextTool: createWorkspaceWriteTextTool(workspaceFilesystem),
  };
}

describe("WorkspacePolicy", () => {
  it("computes deterministic fingerprint", () => {
    const { policy } = setupWorkspacePolicy();
    expect(policy.computeFingerprint()).toHaveLength(64);
  });

  it("evaluates visibility correctly", () => {
    const { policy, workspaceListTool, workspaceWriteTextTool } =
      setupWorkspacePolicy();
    const visible = policy.evaluateVisibility([
      workspaceListTool,
      workspaceWriteTextTool,
    ]);
    expect(visible).toHaveLength(2);
  });

  it("permits safe read-only paths and denies escapes", async () => {
    const { path: tempDir, close } = createTemporaryDatabase();
    const workspaceRoot = joinPath.dirname(tempDir);
    fs.mkdirSync(joinPath.join(workspaceRoot, "sub"));
    const { policy, workspaceListTool } = setupWorkspacePolicy();

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
    const { policy, workspaceWriteTextTool } = setupWorkspacePolicy();

    const res = await policy.evaluateInvocation(
      workspaceWriteTextTool,
      { path: "test.txt", content: "hello", mode: "create" },
      workspaceRoot,
    );
    expect(res.decision).toBe("require-approval");

    close();
  });

  it("denies lexical escapes and returns the normalized admitted target", async () => {
    const workspaceRoot = fs.mkdtempSync(
      joinPath.join(os.tmpdir(), "workspace-policy-"),
    );
    fs.mkdirSync(joinPath.join(workspaceRoot, "safe"));
    const { policy, workspaceListTool } = setupWorkspacePolicy();
    try {
      for (const target of [
        "",
        "/absolute.txt",
        "safe/../../outside.txt",
        "../outside.txt",
        "safe\u0000file.txt",
        "safe\nfile.txt",
        ".env",
      ]) {
        const result = await policy.evaluateInvocation(
          workspaceListTool,
          { path: target },
          workspaceRoot,
        );
        expect(result.decision, target).toBe("deny");
      }

      const result = await policy.evaluateInvocation(
        workspaceListTool,
        { path: "sub/../safe" },
        workspaceRoot,
      );
      expect(result).toMatchObject({
        decision: "allow",
        targetPath: "safe",
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("denies every existing symlink component, including internal links", async () => {
    const parent = fs.mkdtempSync(
      joinPath.join(os.tmpdir(), "workspace-policy-"),
    );
    const workspaceRoot = joinPath.join(parent, "workspace");
    const outsideRoot = joinPath.join(parent, "workspace-escape");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outsideRoot);
    fs.mkdirSync(joinPath.join(workspaceRoot, "inside"));
    fs.writeFileSync(
      joinPath.join(workspaceRoot, "inside", "file.txt"),
      "inside",
    );
    fs.writeFileSync(joinPath.join(outsideRoot, "sentinel.txt"), "outside");
    fs.symlinkSync(outsideRoot, joinPath.join(workspaceRoot, "outside-dir"));
    fs.symlinkSync(
      joinPath.join(outsideRoot, "sentinel.txt"),
      joinPath.join(workspaceRoot, "outside-file"),
    );
    fs.symlinkSync(
      joinPath.join(workspaceRoot, "inside"),
      joinPath.join(workspaceRoot, "inside-dir"),
    );
    fs.symlinkSync(
      joinPath.join(workspaceRoot, "inside", "file.txt"),
      joinPath.join(workspaceRoot, "inside-file"),
    );
    const { policy, workspaceListTool } = setupWorkspacePolicy();
    try {
      for (const target of [
        "outside-dir/sentinel.txt",
        "outside-file",
        "inside-dir/file.txt",
        "inside-file",
      ]) {
        const result = await policy.evaluateInvocation(
          workspaceListTool,
          { path: target },
          workspaceRoot,
        );
        expect(result.decision, target).toBe("deny");
      }
      expect(
        fs.readFileSync(joinPath.join(outsideRoot, "sentinel.txt"), "utf8"),
      ).toBe("outside");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
