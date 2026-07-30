import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { getFsSafeNativeConfig } from "./fs-safe.js";
import { FsSafeWorkspaceFilesystem } from "./workspace-filesystem.js";

describe("FsSafeWorkspaceFilesystem", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const temporaryRoot of temporaryRoots.splice(0)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-workspace-"));
    temporaryRoots.push(root);
    return root;
  }

  it("uses the guarded default native configuration", () => {
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it("lists, reads ranges, creates without clobbering, and writes atomically", async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "read.txt"), "hello world");
    const filesystem = new FsSafeWorkspaceFilesystem();

    await expect(filesystem.list(root, ".")).resolves.toEqual(
      expect.arrayContaining([
        { name: "dir", kind: "directory" },
        { name: "read.txt", kind: "file" },
      ]),
    );
    await expect(
      filesystem.readTextChunk(root, "read.txt", 6, 5),
    ).resolves.toEqual({
      text: "world",
      bytesRead: 5,
      fileSizeBytes: 11,
    });

    await filesystem.createText(root, "created.txt", "initial");
    await expect(
      filesystem.createText(root, "created.txt", "other"),
    ).rejects.toMatchObject({
      code: "TOOL_IMPLEMENTATION_FAILED",
    });
    await filesystem.writeText(root, "created.txt", "replacement");
    await filesystem.writeText(root, "new.txt", "published");
    expect(fs.readFileSync(path.join(root, "created.txt"), "utf8")).toBe(
      "replacement",
    );
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe(
      "published",
    );
  });

  it("inspects the complete existing file for write without a read-size cap", async () => {
    const root = workspace();
    const content = `${"a".repeat(65_536)}suffix-that-changes-the-hash`;
    fs.writeFileSync(path.join(root, "large.txt"), content);
    const filesystem = new FsSafeWorkspaceFilesystem();

    await expect(
      filesystem.inspectTextForWrite(root, "large.txt"),
    ).resolves.toEqual({
      priorState: "existed",
      previousHash: createHash("sha256").update(content).digest("hex"),
    });
    await expect(
      filesystem.inspectTextForWrite(root, "missing.txt"),
    ).resolves.toEqual({ priorState: "none" });
  });

  it("rejects missing parents, non-files, traversal, symlinks, and hardlinks", async () => {
    const parent = workspace();
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.txt");
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "outside");
    fs.mkdirSync(path.join(root, "directory"));
    fs.writeFileSync(path.join(root, "inside.txt"), "inside");
    fs.symlinkSync(
      path.join(root, "inside.txt"),
      path.join(root, "inside-link"),
    );
    fs.linkSync(
      path.join(root, "inside.txt"),
      path.join(root, "inside-hardlink"),
    );
    const filesystem = new FsSafeWorkspaceFilesystem();

    await expect(
      filesystem.createText(root, "missing/file.txt", "x"),
    ).rejects.toMatchObject({
      code: "TOOL_SANDBOX_UNAVAILABLE",
    });
    await expect(
      filesystem.readTextChunk(root, "directory", 0, 10),
    ).rejects.toMatchObject({
      code: "TOOL_IMPLEMENTATION_FAILED",
    });
    await expect(
      filesystem.inspectTextForWrite(root, "directory"),
    ).rejects.toMatchObject({
      code: "TOOL_IMPLEMENTATION_FAILED",
    });
    await expect(
      filesystem.readTextChunk(root, "../fs-safe-outside.txt", 0, 10),
    ).rejects.toMatchObject({
      code: "TOOL_SANDBOX_UNAVAILABLE",
    });
    await expect(
      filesystem.readTextChunk(root, "inside-link", 0, 10),
    ).rejects.toMatchObject({
      code: "TOOL_SANDBOX_UNAVAILABLE",
    });
    await expect(
      filesystem.readTextChunk(root, "inside-hardlink", 0, 10),
    ).rejects.toMatchObject({
      code: "TOOL_SANDBOX_UNAVAILABLE",
    });
  });
});
