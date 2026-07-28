import type { PreparedModelContext } from "../context/prepared-model-context.js";
import type { ModelProvider, ModelResult } from "../models/contracts.js";

export type HarnessModelRoute = Readonly<{
  providerId: "gemini-developer";
  modelId: "gemini-3.5-flash";
}>;

/**
 * One step-oriented harness. A harness executes a single prepared model step
 * through a provider and returns one normalized result. It must not privately
 * continue, retry, or terminalize the run.
 */
export interface Harness {
  executeStep(input: {
    provider: ModelProvider;
    modelCallId: string;
    context: PreparedModelContext;
    modelRoute: HarnessModelRoute;
    signal: AbortSignal;
  }): Promise<ModelResult>;
}

/**
 * Built-in step harness. The provider/model route is supplied by the resolved
 * agent snapshot via `modelRoute`; this class holds no parallel route constant.
 */
export class BuiltinStepHarness implements Harness {
  public async executeStep(input: {
    provider: ModelProvider;
    modelCallId: string;
    context: PreparedModelContext;
    modelRoute: HarnessModelRoute;
    signal: AbortSignal;
  }): Promise<ModelResult> {
    return input.provider.execute(
      {
        modelCallId: input.modelCallId,
        providerId: input.modelRoute.providerId,
        modelId: input.modelRoute.modelId,
        instructions: input.context.instructions,
        turns: input.context.turns,
        continuations: input.context.continuations,
      },
      input.signal,
    );
  }
}
