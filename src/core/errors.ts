export type AppErrorCode =
  | "DOMAIN_VALIDATION_FAILED"
  | "STORAGE_CONFLICT"
  | "STORAGE_UNAVAILABLE"
  | "GATEWAY_PROTOCOL_ERROR"
  | "PROVIDER_REQUEST_FAILED"
  | "CONTEXT_INVALID"
  | "TRANSCRIPT_TAIL_CONFLICT"
  | "TRANSCRIPT_CURSOR_INVALID"
  | "JOURNAL_CURSOR_INVALID"
  | "SESSION_RUN_QUEUE_FULL"
  | "USAGE_RESERVATION_FAILED"
  | "MODEL_HISTORY_INCOMPATIBLE"
  | "HARNESS_NOT_FOUND"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "TOOL_NOT_FOUND"
  | "TOOL_ARGUMENTS_INVALID"
  | "TOOL_POLICY_DENIED"
  | "TOOL_APPROVAL_DENIED"
  | "TOOL_APPROVAL_UNAVAILABLE"
  | "TOOL_APPROVAL_EXPIRED"
  | "TOOL_SANDBOX_UNAVAILABLE"
  | "TOOL_EXECUTION_TIMEOUT"
  | "TOOL_CANCELLED"
  | "TOOL_IMPLEMENTATION_FAILED"
  | "TOOL_OUTCOME_UNCERTAIN"
  | "TOOL_RESULT_TOO_LARGE"
  | "TOOL_BUDGET_EXHAUSTED"
  | "TOOL_NO_PROGRESS";

export type ErrorBoundary =
  | "domain"
  | "storage"
  | "gateway"
  | "provider"
  | "context"
  | "queue"
  | "usage"
  | "tool";

export type ErrorEnvelope = {
  code: AppErrorCode;
  message: string;
};

export class AppError extends Error {
  public constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "STORAGE_UNAVAILABLE",
    message: "An unexpected application error occurred",
  };
}

const boundaryDefaults: Record<ErrorBoundary, AppErrorCode> = {
  domain: "DOMAIN_VALIDATION_FAILED",
  storage: "STORAGE_UNAVAILABLE",
  gateway: "GATEWAY_PROTOCOL_ERROR",
  provider: "PROVIDER_REQUEST_FAILED",
  context: "CONTEXT_INVALID",
  queue: "SESSION_RUN_QUEUE_FULL",
  usage: "USAGE_RESERVATION_FAILED",
  tool: "TOOL_IMPLEMENTATION_FAILED",
};

export function normalizeError(
  boundary: ErrorBoundary,
  error: unknown,
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (
    boundary === "storage" &&
    error instanceof Error &&
    /UNIQUE constraint failed|SQLITE_CONSTRAINT/.test(error.message)
  ) {
    return new AppError(
      "STORAGE_CONFLICT",
      "The requested persistent state conflicts with an existing record",
      error,
    );
  }

  return new AppError(
    boundaryDefaults[boundary],
    `${boundary} operation failed`,
    error,
  );
}

export function normalizeStorageError(error: unknown): AppError {
  return normalizeError("storage", error);
}
