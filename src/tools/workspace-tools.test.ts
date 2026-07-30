import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors.js";
import { FsSafeWorkspaceFilesystem } from "../platform/workspace-filesystem.js";
import type { ToolExecutionContext } from "./contracts.js";
import type { WorkspaceFilesystem } from "./workspace-filesystem.js";
import {
  createWorkspaceListTool,
  createWorkspaceReadTextTool,
  createWorkspaceWriteTextTool,
} from "./workspace-tools.js";

const workspaceFilesystem = new FsSafeWorkspaceFilesystem();
const workspaceListTool = createWorkspaceListTool(workspaceFilesystem);
const workspaceReadTextTool = createWorkspaceReadTextTool(workspaceFilesystem);
const workspaceWriteTextTool =
  createWorkspaceWriteTextTool(workspaceFilesystem);

function context(
  workspaceRoot: string,
  targetPath: string,
  signal?: AbortSignal,
): ToolExecutionContext {
  return {
    agentId: "agent_primary" as any,
    workspaceRoot,
    targetPath,
    toolCallId: "tool_call" as any,
    inputLimits: {},
    outputLimits: {},
    policyConstraints: {},
    sandboxProfile: "host-workspace-v1",
    markIoStarted: () => {},
    markSideEffectPossible: () => {},
    ...(signal ? { signal } : {}),
  };
}

describe("workspace tools containment", () => {
  it("independently rejects escaped and symlink targets when policy is bypassed", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-tools-"));
    const workspaceRoot = path.join(parent, "workspace");
    const outsideRoot = path.join(parent, "workspace-escape");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outsideRoot);
    fs.mkdirSync(path.join(workspaceRoot, "inside"));
    fs.writeFileSync(path.join(outsideRoot, "sentinel.txt"), "outside secret");
    fs.writeFileSync(path.join(workspaceRoot, "inside", "file.txt"), "inside");
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "outside-dir"));
    fs.symlinkSync(
      path.join(outsideRoot, "sentinel.txt"),
      path.join(workspaceRoot, "outside-file"),
    );
    fs.symlinkSync(
      path.join(workspaceRoot, "inside"),
      path.join(workspaceRoot, "inside-dir"),
    );
    fs.symlinkSync(
      path.join(workspaceRoot, "inside", "file.txt"),
      path.join(workspaceRoot, "inside-file"),
    );
    try {
      for (const target of [
        "../workspace-escape/sentinel.txt",
        "outside-dir/sentinel.txt",
        "outside-file",
        "inside-dir/file.txt",
        "inside-file",
      ]) {
        await expect(
          workspaceReadTextTool.execute(
            { path: target },
            context(workspaceRoot, target),
          ),
        ).rejects.toMatchObject({ code: "TOOL_SANDBOX_UNAVAILABLE" });
      }

      await expect(
        workspaceWriteTextTool.execute(
          { path: "outside-dir/new.txt", content: "escaped", mode: "create" },
          context(workspaceRoot, "outside-dir/new.txt"),
        ),
      ).rejects.toMatchObject({ code: "TOOL_SANDBOX_UNAVAILABLE" });
      await expect(
        workspaceWriteTextTool.execute(
          { path: "outside-file", content: "escaped", mode: "write" },
          context(workspaceRoot, "outside-file"),
        ),
      ).rejects.toMatchObject({ code: "TOOL_SANDBOX_UNAVAILABLE" });
      expect(
        fs.readFileSync(path.join(outsideRoot, "sentinel.txt"), "utf8"),
      ).toBe("outside secret");
      expect(fs.existsSync(path.join(outsideRoot, "new.txt"))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uses normalized execution context paths for safe workspace I/O", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "workspace-tools-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "safe.txt"), "safe content");
    try {
      const result = await workspaceReadTextTool.execute(
        { path: "sub/../safe.txt" },
        context(workspaceRoot, "safe.txt"),
      );
      expect(result).toMatchObject({ path: "safe.txt", text: "safe content" });
      await expect(
        workspaceListTool.execute(
          { path: "/tmp" },
          context(workspaceRoot, "/tmp"),
        ),
      ).rejects.toMatchObject({ code: "TOOL_SANDBOX_UNAVAILABLE" });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses write semantics for both new and existing regular files", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "workspace-tools-"),
    );
    try {
      const created = await workspaceWriteTextTool.execute(
        { path: "write.txt", content: "first", mode: "write" },
        context(workspaceRoot, "write.txt"),
      );
      const overwritten = await workspaceWriteTextTool.execute(
        { path: "write.txt", content: "second", mode: "write" },
        context(workspaceRoot, "write.txt"),
      );

      expect(created).toMatchObject({ mode: "write", priorState: "none" });
      expect(overwritten).toMatchObject({
        mode: "write",
        priorState: "existed",
      });
      expect(
        fs.readFileSync(path.join(workspaceRoot, "write.txt"), "utf8"),
      ).toBe("second");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns the hash of the complete previous file when writing a large file", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "workspace-tools-"),
    );
    const oldContent = `${"prefix".repeat(11_000)}suffix-that-changes-the-hash`;
    const prefixHash = createHash("sha256")
      .update(oldContent.slice(0, 65_536))
      .digest("hex");
    const completeHash = createHash("sha256").update(oldContent).digest("hex");
    fs.writeFileSync(path.join(workspaceRoot, "large.txt"), oldContent);
    try {
      const result = await workspaceWriteTextTool.execute(
        { path: "large.txt", content: "replacement", mode: "write" },
        context(workspaceRoot, "large.txt"),
      );

      expect(result).toMatchObject({
        priorState: "existed",
        previousHash: completeHash,
      });
      expect(result.previousHash).not.toBe(prefixHash);
      expect(
        fs.readFileSync(path.join(workspaceRoot, "large.txt"), "utf8"),
      ).toBe("replacement");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not write when previous-state inspection fails", async () => {
    let writeTextCalls = 0;
    let starts = 0;
    let sideEffects = 0;
    const filesystem: WorkspaceFilesystem = {
      preflight: async () => undefined,
      list: async () => [],
      readTextChunk: async () => ({ text: "", bytesRead: 0, fileSizeBytes: 0 }),
      inspectTextForWrite: async () => {
        throw new AppError(
          "TOOL_IMPLEMENTATION_FAILED",
          "injected inspection failure",
        );
      },
      createText: async () => undefined,
      writeText: async () => {
        writeTextCalls++;
      },
    };
    const writeTool = createWorkspaceWriteTextTool(filesystem);

    await expect(
      writeTool.execute(
        { path: "target.txt", content: "new", mode: "write" },
        {
          ...context("/workspace", "target.txt"),
          markIoStarted: () => starts++,
          markSideEffectPossible: () => sideEffects++,
        },
      ),
    ).rejects.toMatchObject({ code: "TOOL_IMPLEMENTATION_FAILED" });
    expect(writeTextCalls).toBe(0);
    expect(starts).toBe(1);
    expect(sideEffects).toBe(0);
  });

  it("passes one invocation signal through every workspace operation", async () => {
    const received: AbortSignal[] = [];
    const filesystem: WorkspaceFilesystem = {
      preflight: async () => undefined,
      list: async (_root, _path, signal) => {
        received.push(signal!);
        return [];
      },
      readTextChunk: async (_root, _path, _offset, _max, signal) => {
        received.push(signal!);
        return { text: "", bytesRead: 0, fileSizeBytes: 0 };
      },
      inspectTextForWrite: async (_root, _path, signal) => {
        received.push(signal!);
        return { priorState: "none" };
      },
      createText: async (_root, _path, _content, signal) => {
        received.push(signal!);
      },
      writeText: async (_root, _path, _content, signal) => {
        received.push(signal!);
      },
    };
    const controller = new AbortController();
    const markerCalls: string[] = [];
    const invocationContext = {
      ...context("/workspace", "file.txt", controller.signal),
      markIoStarted: () => markerCalls.push("io"),
      markSideEffectPossible: () => markerCalls.push("effect"),
    };

    await createWorkspaceListTool(filesystem).execute(
      { path: "file.txt" },
      invocationContext,
    );
    await createWorkspaceReadTextTool(filesystem).execute(
      { path: "file.txt" },
      invocationContext,
    );
    await createWorkspaceWriteTextTool(filesystem).execute(
      { path: "file.txt", content: "new", mode: "write" },
      invocationContext,
    );
    await createWorkspaceWriteTextTool(filesystem).execute(
      { path: "file.txt", content: "new", mode: "create" },
      invocationContext,
    );

    expect(received).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
    expect(markerCalls).toEqual(["io", "io", "io", "effect", "io", "effect"]);
  });

  describe("G2 authoritative start and marker ordering", () => {
    it("verifies no tool.started before markIoStarted, single tool.started emission, and exact workspace-tool marker order", async () => {
      const sequence: string[] = [];
      const filesystem: WorkspaceFilesystem = {
        preflight: async () => undefined,
        list: async () => {
          sequence.push("filesystem.list");
          return [];
        },
        readTextChunk: async () => {
          sequence.push("filesystem.readTextChunk");
          return { text: "data", bytesRead: 4, fileSizeBytes: 4 };
        },
        inspectTextForWrite: async () => {
          sequence.push("filesystem.inspectTextForWrite");
          return { priorState: "existed", previousHash: "abc" };
        },
        createText: async () => {
          sequence.push("filesystem.createText");
        },
        writeText: async () => {
          sequence.push("filesystem.writeText");
        },
      };

      const listTool = createWorkspaceListTool(filesystem);
      const readTool = createWorkspaceReadTextTool(filesystem);
      const writeTool = createWorkspaceWriteTextTool(filesystem);

      let startedCount = 0;
      const makeContext = (targetPath: string): ToolExecutionContext => ({
        agentId: "agent_primary" as any,
        workspaceRoot: "/workspace",
        targetPath,
        toolCallId: "tool_call" as any,
        inputLimits: {},
        outputLimits: {},
        policyConstraints: {},
        sandboxProfile: "host-workspace-v1",
        markIoStarted: () => {
          startedCount++;
          sequence.push("markIoStarted");
        },
        markSideEffectPossible: () => {
          sequence.push("markSideEffectPossible");
        },
      });

      // 1. workspace.list
      sequence.length = 0;
      startedCount = 0;
      await listTool.execute({ path: "dir" }, makeContext("dir"));
      expect(startedCount).toBe(1);
      expect(sequence).toEqual(["markIoStarted", "filesystem.list"]);

      // 2. workspace.read_text
      sequence.length = 0;
      startedCount = 0;
      await readTool.execute({ path: "file.txt" }, makeContext("file.txt"));
      expect(startedCount).toBe(1);
      expect(sequence).toEqual(["markIoStarted", "filesystem.readTextChunk"]);

      // 3. workspace.write_text mode=write
      sequence.length = 0;
      startedCount = 0;
      await writeTool.execute(
        { path: "file.txt", content: "x", mode: "write" },
        makeContext("file.txt"),
      );
      expect(startedCount).toBe(1);
      expect(sequence).toEqual([
        "markIoStarted",
        "filesystem.inspectTextForWrite",
        "markSideEffectPossible",
        "filesystem.writeText",
      ]);

      // 4. workspace.write_text mode=create
      sequence.length = 0;
      startedCount = 0;
      await writeTool.execute(
        { path: "file.txt", content: "x", mode: "create" },
        makeContext("file.txt"),
      );
      expect(startedCount).toBe(1);
      expect(sequence).toEqual([
        "markIoStarted",
        "markSideEffectPossible",
        "filesystem.createText",
      ]);
    });
  });
});
