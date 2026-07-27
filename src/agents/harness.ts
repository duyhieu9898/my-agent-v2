import type { PreparedModelContext } from "../context/prepared-model-context.js";
import type { ModelProvider, ModelResult } from "../models/contracts.js";

export class BuiltinStepHarness {
  public async executeStep(input: {
    provider: ModelProvider;
    modelCallId: string;
    context: PreparedModelContext;
    signal: AbortSignal;
  }): Promise<ModelResult> {
    return input.provider.execute(
      {
        modelCallId: input.modelCallId,
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: input.context.instructions,
        turns: input.context.turns,
      },
      input.signal,
    );
  }
}
