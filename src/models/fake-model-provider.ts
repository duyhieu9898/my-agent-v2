import type { ModelProvider, ModelRequest, ModelResult } from "./contracts.js";

export class FakeModelProvider implements ModelProvider {
  public readonly requests: ModelRequest[] = [];
  private readonly results: ModelResult[];
  private index = 0;

  public constructor(result: ModelResult | ModelResult[]) {
    this.results = Array.isArray(result) ? result : [result];
  }

  async execute(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    if (signal.aborted) throw new Error("MODEL_CANCELLED");
    this.requests.push(request);
    const res = (this.results[this.index] ??
      this.results[this.results.length - 1])!;
    this.index++;
    return res;
  }
}
