export type CheckpointDecision =
  "continue" | "complete" | "retry-attempt" | "cancel" | "fail";
export type StageResult = { kind: "ok" | "failed"; code?: string };
export interface RunStage {
  execute(): Promise<StageResult>;
}
export class CheckpointStage {
  decide(input: {
    cancelled: boolean;
    result: StageResult;
  }): CheckpointDecision {
    if (input.cancelled) return "cancel";
    return input.result.kind === "ok" ? "complete" : "fail";
  }
}
export class FinalizeStage {
  private completion: Promise<void> | undefined;
  execute(action: () => Promise<void>): Promise<void> {
    this.completion ??= action();
    return this.completion;
  }
}
