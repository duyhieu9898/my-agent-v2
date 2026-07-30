import * as path from "node:path";

import { AppError, type AppErrorCode } from "../core/errors.js";
import type {
  WorkspaceEntry,
  WorkspaceFilesystem,
  WorkspaceOperation,
  WorkspaceTextChunk,
} from "../tools/workspace-filesystem.js";
import { assertStrictWorkspacePath } from "../tools/workspace-path-policy.js";
import { FsSafeError, root, type Root } from "./fs-safe.js";

const ROOT_DEFAULTS = {
  symlinks: "reject",
  hardlinks: "reject",
  mkdir: false,
  maxBytes: 65_536,
  mode: 0o600,
} as const;

export class FsSafeWorkspaceFilesystem implements WorkspaceFilesystem {
  private readonly roots = new Map<string, Promise<Root>>();

  public async preflight(
    workspaceRoot: string,
    targetPath: string,
    operation: WorkspaceOperation,
  ): Promise<void> {
    await this.assertStrictPath(workspaceRoot, targetPath);
    const safeRoot = await this.getRoot(workspaceRoot);
    try {
      if (operation === "list") {
        this.requireDirectory((await safeRoot.stat(targetPath)).isDirectory);
        return;
      }

      if (operation === "read") {
        this.requireRegularFile((await safeRoot.stat(targetPath)).isFile);
        return;
      }

      const parent = path.dirname(targetPath);
      this.requireDirectory((await safeRoot.stat(parent)).isDirectory);
      try {
        this.requireRegularFile((await safeRoot.stat(targetPath)).isFile);
      } catch (error) {
        if (!isFsSafeCode(error, "not-found")) throw error;
      }
    } catch (error) {
      throw mapFsSafeError(error);
    }
  }

  public async list(
    workspaceRoot: string,
    targetPath: string,
  ): Promise<WorkspaceEntry[]> {
    await this.assertStrictPath(workspaceRoot, targetPath);
    const safeRoot = await this.getRoot(workspaceRoot);
    try {
      const entries = await safeRoot.list(targetPath, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory ? "directory" : "file",
      }));
    } catch (error) {
      throw mapFsSafeError(error);
    }
  }

  public async readTextChunk(
    workspaceRoot: string,
    targetPath: string,
    offsetBytes: number,
    maxBytes: number,
  ): Promise<WorkspaceTextChunk> {
    await this.assertStrictPath(workspaceRoot, targetPath);
    const safeRoot = await this.getRoot(workspaceRoot);
    try {
      const opened = await safeRoot.open(targetPath);
      try {
        this.requireRegularFile(opened.stat.isFile());
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await opened.handle.read(
          buffer,
          0,
          maxBytes,
          offsetBytes,
        );
        return {
          text: buffer.subarray(0, bytesRead).toString("utf8"),
          bytesRead,
          fileSizeBytes: opened.stat.size,
        };
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      throw mapFsSafeError(error);
    }
  }

  public async createText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
  ): Promise<void> {
    await this.assertStrictPath(workspaceRoot, targetPath);
    const safeRoot = await this.getRoot(workspaceRoot);
    try {
      await safeRoot.create(targetPath, content, { mkdir: false });
    } catch (error) {
      throw mapFsSafeError(error);
    }
  }

  public async writeText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
  ): Promise<void> {
    await this.assertStrictPath(workspaceRoot, targetPath);
    const safeRoot = await this.getRoot(workspaceRoot);
    try {
      await safeRoot.write(targetPath, content, {
        mkdir: false,
        overwrite: true,
      });
    } catch (error) {
      throw mapFsSafeError(error);
    }
  }

  private async assertStrictPath(
    workspaceRoot: string,
    targetPath: string,
  ): Promise<void> {
    await assertStrictWorkspacePath(workspaceRoot, targetPath);
  }

  private getRoot(workspaceRoot: string): Promise<Root> {
    const cached = this.roots.get(workspaceRoot);
    if (cached) return cached;

    const created = root(workspaceRoot, ROOT_DEFAULTS).catch(
      (error: unknown) => {
        this.roots.delete(workspaceRoot);
        throw mapFsSafeError(error);
      },
    );
    this.roots.set(workspaceRoot, created);
    return created;
  }

  private requireDirectory(isDirectory: boolean): void {
    if (!isDirectory) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        "Path is not a directory",
      );
    }
  }

  private requireRegularFile(isFile: boolean): void {
    if (!isFile) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        "Path is not a regular file",
      );
    }
  }
}

function isFsSafeCode(error: unknown, code: string): boolean {
  return error instanceof FsSafeError && error.code === code;
}

export function mapFsSafeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof FsSafeError)) {
    return new AppError(
      "TOOL_IMPLEMENTATION_FAILED",
      "Workspace filesystem operation failed",
      error,
    );
  }

  const code = error.code;
  const appCode: AppErrorCode =
    code === "outside-workspace" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink" ||
    code === "hardlink" ||
    code === "invalid-path" ||
    code === "device-path"
      ? "TOOL_SANDBOX_UNAVAILABLE"
      : code === "timeout"
        ? "TOOL_EXECUTION_TIMEOUT"
        : code === "too-large"
          ? "TOOL_RESULT_TOO_LARGE"
          : "TOOL_IMPLEMENTATION_FAILED";

  return new AppError(appCode, "Workspace filesystem operation failed", error);
}
