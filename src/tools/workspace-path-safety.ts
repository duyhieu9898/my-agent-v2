import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../core/errors.js";

export function normalizeWorkspaceTarget(rawTarget: string): string {
  if (rawTarget.length === 0) {
    throw new AppError("TOOL_SANDBOX_UNAVAILABLE", "Workspace path is empty");
  }

  for (let index = 0; index < rawTarget.length; index++) {
    const code = rawTarget.charCodeAt(index);
    if (code <= 31 || code === 127) {
      throw new AppError(
        "TOOL_SANDBOX_UNAVAILABLE",
        "Workspace path contains a control character",
      );
    }
  }

  if (path.isAbsolute(rawTarget)) {
    throw new AppError(
      "TOOL_SANDBOX_UNAVAILABLE",
      "Workspace path must be relative",
    );
  }

  const normalizedTarget = path.normalize(rawTarget);
  if (
    normalizedTarget === ".." ||
    normalizedTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalizedTarget)
  ) {
    throw new AppError(
      "TOOL_SANDBOX_UNAVAILABLE",
      "Workspace path escapes the workspace",
    );
  }

  return normalizedTarget;
}

export function isWorkspacePathContained(
  workspaceRoot: string,
  candidate: string,
): boolean {
  return (
    candidate === workspaceRoot ||
    candidate.startsWith(`${workspaceRoot}${path.sep}`)
  );
}

export async function resolveSafeWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
): Promise<{ workspaceRoot: string; targetPath: string; fullPath: string }> {
  const normalizedTarget = normalizeWorkspaceTarget(targetPath);
  let trustedWorkspaceRoot: string;
  try {
    trustedWorkspaceRoot = await fs.promises.realpath(workspaceRoot);
  } catch {
    throw new AppError(
      "TOOL_SANDBOX_UNAVAILABLE",
      "Workspace root is unavailable",
    );
  }

  const fullPath = path.resolve(trustedWorkspaceRoot, normalizedTarget);
  if (!isWorkspacePathContained(trustedWorkspaceRoot, fullPath)) {
    throw new AppError(
      "TOOL_SANDBOX_UNAVAILABLE",
      "Workspace path escapes the workspace",
    );
  }

  const relative = path.relative(trustedWorkspaceRoot, fullPath);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = trustedWorkspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const metadata = await fs.promises.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new AppError(
          "TOOL_SANDBOX_UNAVAILABLE",
          "Workspace path contains a symbolic link",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }

  return {
    workspaceRoot: trustedWorkspaceRoot,
    targetPath: normalizedTarget,
    fullPath,
  };
}
