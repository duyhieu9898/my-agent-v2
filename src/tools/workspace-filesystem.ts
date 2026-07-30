export type WorkspaceOperation = "list" | "read" | "create" | "write";

export type WorkspaceEntry = {
  name: string;
  kind: "file" | "directory";
};

export type WorkspaceTextChunk = {
  text: string;
  bytesRead: number;
  fileSizeBytes: number;
};

export type WorkspaceWritePriorState =
  { priorState: "none" } | { priorState: "existed"; previousHash: string };

/** Project-owned workspace I/O boundary shared by policy and tool execution. */
export interface WorkspaceFilesystem {
  preflight(
    workspaceRoot: string,
    targetPath: string,
    operation: WorkspaceOperation,
  ): Promise<void>;
  list(
    workspaceRoot: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceEntry[]>;
  readTextChunk(
    workspaceRoot: string,
    targetPath: string,
    offsetBytes: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceTextChunk>;
  inspectTextForWrite(
    workspaceRoot: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceWritePriorState>;
  createText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void>;
  writeText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
