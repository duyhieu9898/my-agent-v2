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

/** Project-owned workspace I/O boundary shared by policy and tool execution. */
export interface WorkspaceFilesystem {
  preflight(
    workspaceRoot: string,
    targetPath: string,
    operation: WorkspaceOperation,
  ): Promise<void>;
  list(workspaceRoot: string, targetPath: string): Promise<WorkspaceEntry[]>;
  readTextChunk(
    workspaceRoot: string,
    targetPath: string,
    offsetBytes: number,
    maxBytes: number,
  ): Promise<WorkspaceTextChunk>;
  createText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
  ): Promise<void>;
  writeText(
    workspaceRoot: string,
    targetPath: string,
    content: string,
  ): Promise<void>;
}
