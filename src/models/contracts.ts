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

export type ModelToolDefinition = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>;

export type ModelTurnToolCall = Readonly<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}>;

export type ModelTurnToolResult = Readonly<{
  id: string;
  name: string;
  result: unknown;
}>;

export type ModelTurn = Readonly<{
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: readonly ModelTurnToolCall[];
  toolResults?: readonly ModelTurnToolResult[];
}>;

export type ModelRequest = Readonly<{
  modelCallId: string;
  providerId: "gemini-developer";
  modelId: "gemini-3.5-flash";
  instructions: readonly string[];
  turns: readonly ModelTurn[];
  tools?: readonly ModelToolDefinition[];
  continuations?: readonly Readonly<{
    providerId: "gemini-developer";
    modelId: "gemini-3.5-flash";
    modelCallId: string;
    version: "gemini-thought-signature-v1";
    payload: Uint8Array;
  }>[];
}>;

export type ModelResultToolCall = Readonly<{
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}>;

export type ModelResult = Readonly<{
  text?: string;
  toolCalls?: readonly ModelResultToolCall[];
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
