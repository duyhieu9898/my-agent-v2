import * as path from "node:path";

import { AppError } from "../core/errors.js";

/** Normalization used for policy, approvals, execution context, and results. */
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
