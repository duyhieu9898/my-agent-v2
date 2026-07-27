import { describe, expect, it } from "vitest";
import { prepareModelContext } from "./prepared-model-context.js";
describe("prepareModelContext", () => {
  it("rejects incomplete local transcript history", () => {
    try {
      prepareModelContext({
        input: "next",
        history: [
          {
            sequence: 1,
            type: "message",
            id: "u",
            role: "user",
            text: "unfinished",
            createdAt: "2026-07-24T00:00:00.000Z",
          },
        ],
      });
      throw new Error("expected context preparation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_HISTORY_INCOMPATIBLE" });
    }
  });
  it("records deterministic local provenance and hashes", () => {
    const context = prepareModelContext({ input: "next", history: [] });
    expect(context.manifest.sources).toEqual([
      expect.objectContaining({
        id: "run-input",
        provenance: "run-input",
        bytes: 4,
      }),
    ]);
    expect(context.manifest.sources[0]?.hash).toHaveLength(64);
  });
  it("uses the ordered main-v1 prompt plan", () => {
    expect(
      prepareModelContext({ input: "next", history: [] }).promptPlan.sections,
    ).toEqual(["instructions", "history", "current-input"]);
  });
});
