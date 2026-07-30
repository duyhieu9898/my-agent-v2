import * as path from "node:path";

import { AppError } from "../core/errors.js";
import { assertNoSymlinkParents } from "../platform/fs-safe-advanced.js";

/** my-agent-v2's stricter rule: reject every existing symlink component. */
export async function assertStrictWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  try {
    await assertNoSymlinkParents({
      rootDir: workspaceRoot,
      targetPath: path.join(workspaceRoot, targetPath),
      allowMissing: true,
    });
  } catch (error) {
    throw new AppError(
      "TOOL_SANDBOX_UNAVAILABLE",
      "Workspace path failed strict symlink policy",
      error,
    );
  }
}
