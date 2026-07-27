import { GoogleGenAI } from "@google/genai";

import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from "./contracts.js";

type InteractionsClient = Pick<GoogleGenAI, "interactions">;

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
          input: request.turns.map((turn) => ({
            type: turn.role === "assistant" ? "model_output" : "user_input",
            content: [{ type: "text", text: turn.text }],
          })),
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
      usage_metadata?: {
        total_token_count?: number;
        prompt_token_count?: number;
        candidates_token_count?: number;
      };
    };
    return {
      text: response.output_text ?? "",
      ...(response.id ? { providerInteractionId: response.id } : {}),
      usage: {
        ...(response.usage_metadata?.total_token_count !== undefined
          ? {
              providerTotalTokens: BigInt(
                response.usage_metadata.total_token_count,
              ),
            }
          : {}),
        ...(response.usage_metadata?.prompt_token_count !== undefined
          ? { inputTokens: BigInt(response.usage_metadata.prompt_token_count) }
          : {}),
        ...(response.usage_metadata?.candidates_token_count !== undefined
          ? {
              outputTokens: BigInt(
                response.usage_metadata.candidates_token_count,
              ),
            }
          : {}),
        measurement: response.usage_metadata ? "provider-exact" : "unknown",
      },
      billingCertainty: "actual-known",
    };
  }
}
