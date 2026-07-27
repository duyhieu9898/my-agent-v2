import { describe, expect, it } from "vitest";
import { GeminiInteractionsProvider } from "./gemini-interactions-provider.js";

describe("GeminiInteractionsProvider", () => {
  it("uses Interactions with store=false and never sends previous interaction state", async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return {
            output_text: "Hi",
            usage_metadata: { total_token_count: 2 },
          };
        },
      },
    } as never);
    const result = await provider.execute(
      {
        modelCallId: "call",
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
        instructions: ["rule"],
        turns: [{ role: "user", text: "Hello" }],
      },
      new AbortController().signal,
    );
    expect(captured).toMatchObject({ model: "gemini-3.5-flash", store: false });
    expect(captured).toMatchObject({
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    expect(captured).not.toHaveProperty("previous_interaction_id");
    expect(result.text).toBe("Hi");
  });
  it("classifies a Gemini 429 as not billable", async () => {
    const provider = new GeminiInteractionsProvider("not-used", {
      interactions: {
        create: async () => {
          throw { status: 429 };
        },
      },
    } as never);
    await expect(
      provider.execute(
        {
          modelCallId: "call",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          instructions: [],
          turns: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ billingCertainty: "not-billable" });
  });
});
