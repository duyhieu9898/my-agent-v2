import type { ModelProvider, ModelRequest, ModelResult } from "./contracts.js";

export class FakeModelProvider implements ModelProvider {
  public readonly requests: ModelRequest[] = [];
  public constructor(private readonly result: ModelResult) {}
  async execute(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    if (signal.aborted) throw new Error("MODEL_CANCELLED");
    this.requests.push(request);
    return this.result;
  }
}
