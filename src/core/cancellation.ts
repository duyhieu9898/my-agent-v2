export class OperationCancelledError extends Error {
  public constructor() {
    super("Operation cancelled");
    this.name = "OperationCancelledError";
  }
}

export type CancellationScope = {
  readonly signal: AbortSignal;
  cancel(): void;
};

export function createCancellationScope(
  parentSignal?: AbortSignal,
): CancellationScope {
  const controller = new AbortController();

  const cancel = (): void => {
    controller.abort();
  };

  if (parentSignal?.aborted) {
    cancel();
  } else {
    parentSignal?.addEventListener("abort", cancel, { once: true });
  }

  return {
    signal: controller.signal,
    cancel,
  };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OperationCancelledError();
  }
}

export async function executeAbortable<Result>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  throwIfAborted(signal);
  const result = await operation(signal);
  throwIfAborted(signal);

  return result;
}
