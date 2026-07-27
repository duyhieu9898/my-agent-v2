export type BillingCertainty =
  "not-dispatched" | "not-billable" | "actual-known" | "billing-ambiguous";

export type NormalizedModelUsage = Readonly<{
  providerTotalTokens?: bigint;
  inputTokens?: bigint;
  cachedInputTokens?: bigint;
  outputTokens?: bigint;
  thinkingTokens?: bigint;
  measurement: "provider-exact" | "partial" | "unknown";
}>;

export type ModelRequest = Readonly<{
  modelCallId: string;
  providerId: "gemini-developer";
  modelId: "gemini-3.5-flash";
  instructions: readonly string[];
  turns: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
}>;

export type ModelResult = Readonly<{
  text: string;
  providerInteractionId?: string;
  usage: NormalizedModelUsage;
  billingCertainty: BillingCertainty;
  requiresContinuation?: boolean;
  continuation?: Readonly<{ version: string; payload: Uint8Array }>;
}>;

export interface ModelProvider {
  execute(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

export class ModelProviderError extends Error {
  public constructor(
    message: string,
    public readonly billingCertainty: BillingCertainty,
  ) {
    super(message);
  }
}
