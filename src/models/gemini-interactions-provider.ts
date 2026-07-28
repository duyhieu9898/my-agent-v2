import { GoogleGenAI } from "@google/genai";

import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from "./contracts.js";

export type InteractionsClient = Pick<GoogleGenAI, "interactions">;

/** Gemini Developer API adapter. It intentionally owns the SDK boundary. */
export class GeminiInteractionsProvider implements ModelProvider {
  private readonly client: InteractionsClient;
  public constructor(apiKey: string, client?: InteractionsClient) {
    this.client = client ?? new GoogleGenAI({ apiKey });
  }
  async execute(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    let raw: unknown;
    try {
      raw = await this.client.interactions.create(
        {
          model: request.modelId,
          store: false,
          system_instruction: request.instructions.join("\n"),
          input: [
            ...request.turns.map((turn) => ({
              type: turn.role === "assistant" ? "model_output" : "user_input",
              content: [{ type: "text", text: turn.text }],
            })),
            ...(request.continuations ?? []).map((continuation) => ({
              type: "thought",
              signature: new TextDecoder().decode(continuation.payload),
            })),
          ],
        } as never,
        { signal },
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new ModelProviderError(
        status === undefined
          ? "Gemini Interactions request failed"
          : `Gemini Interactions request failed with HTTP ${status}`,
        status !== undefined && status >= 400 && status < 500
          ? "not-billable"
          : "billing-ambiguous",
      );
    }
    const response = raw as {
      output_text?: string;
      id?: string;
      usage?: {
        total_tokens?: number;
        total_input_tokens?: number;
        total_output_tokens?: number;
        total_cached_tokens?: number;
        total_thought_tokens?: number;
      };
      steps?: Array<{ type?: string; signature?: unknown }>;
    };
    const usage = normalizeUsage(response.usage);
    const signatures = (response.steps ?? [])
      .filter(
        (
          step,
        ): step is {
          type: "thought" | "thought_signature";
          signature: string;
        } =>
          (step.type === "thought" || step.type === "thought_signature") &&
          typeof step.signature === "string",
      )
      .map((step) => step.signature);
    const hasThought = (response.steps ?? []).some(
      (step) => step.type === "thought" || step.type === "thought_signature",
    );
    const continuation = signatures.at(-1);
    return {
      text: response.output_text ?? "",
      ...(response.id ? { providerInteractionId: response.id } : {}),
      usage: usage.value,
      billingCertainty: usage.usable ? "actual-known" : "billing-ambiguous",
      ...(hasThought ? { requiresContinuation: true } : {}),
      ...(continuation
        ? {
            continuation: {
              version: "gemini-thought-signature-v1",
              payload: new TextEncoder().encode(continuation),
            },
          }
        : {}),
    };
  }
}

function normalizeUsage(value: unknown): {
  usable: boolean;
  value: ModelResult["usage"];
} {
  if (!value || typeof value !== "object")
    return { usable: false, value: { measurement: "unknown" } };
  const usage = value as Record<string, unknown>;
  const fields = [
    "total_tokens",
    "total_input_tokens",
    "total_output_tokens",
  ] as const;
  if (!fields.every((field) => isTokenCount(usage[field])))
    return { usable: false, value: { measurement: "unknown" } };
  const total = usage.total_tokens as number;
  const input = usage.total_input_tokens as number;
  const output = usage.total_output_tokens as number;
  if (total < input + output)
    return { usable: false, value: { measurement: "unknown" } };
  return {
    usable: true,
    value: {
      providerTotalTokens: BigInt(total),
      inputTokens: BigInt(input),
      outputTokens: BigInt(output),
      ...(isTokenCount(usage.total_cached_tokens)
        ? { cachedInputTokens: BigInt(usage.total_cached_tokens) }
        : {}),
      ...(isTokenCount(usage.total_thought_tokens)
        ? { thinkingTokens: BigInt(usage.total_thought_tokens) }
        : {}),
      measurement: "provider-exact",
    },
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
