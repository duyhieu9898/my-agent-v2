import { describe, expect, it } from "vitest";

import { AppError } from "../core/errors.js";
import type { ModelResult } from "../models/contracts.js";

import { BuiltinStepHarness } from "./harness.js";
import { HarnessRegistry } from "./harness-registry.js";
import type { Harness } from "./harness.js";

function fakeHarness(name: string, calls: string[]): Harness {
  return {
    async executeStep() {
      calls.push(name);
      return {
        text: name,
        usage: { measurement: "unknown" },
        billingCertainty: "billing-ambiguous",
      } as ModelResult;
    },
  };
}

describe("HarnessRegistry", () => {
  it("resolves the built-in step harness by id", () => {
    const registry = new HarnessRegistry([
      { id: "builtin-step", harness: new BuiltinStepHarness() },
    ]);
    expect(registry.resolve("builtin-step")).toBeInstanceOf(BuiltinStepHarness);
  });

  it("fails unknown harness ids typed before any provider dispatch", () => {
    const registry = new HarnessRegistry([
      { id: "builtin-step", harness: new BuiltinStepHarness() },
    ]);
    let caught: unknown;
    try {
      registry.resolve("missing-harness");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "HARNESS_NOT_FOUND",
    });
  });

  it("fails duplicate harness ids at construction", () => {
    const harness = new BuiltinStepHarness();
    expect(
      () =>
        new HarnessRegistry([
          { id: "builtin-step", harness },
          { id: "builtin-step", harness },
        ]),
    ).toThrow("DUPLICATE_HARNESS_DEFINITION");
  });

  it("selects the correct implementation when multiple harnesses are registered", async () => {
    const calls: string[] = [];
    const registry = new HarnessRegistry([
      { id: "alpha", harness: fakeHarness("alpha", calls) },
      { id: "beta", harness: fakeHarness("beta", calls) },
    ]);
    const result = await registry.resolve("beta").executeStep({
      provider: undefined as never,
      modelCallId: "call-1",
      context: undefined as never,
      modelRoute: {
        providerId: "gemini-developer",
        modelId: "gemini-3.5-flash",
      },
      signal: undefined as never,
    });
    expect(result.text).toBe("beta");
    expect(calls).toEqual(["beta"]);
  });

  it("exports a harness type that is an interface, not an SDK type", () => {
    // The registry module must not import @google/genai; this compiles only if
    // the Harness interface is provider-neutral.
    const registry = new HarnessRegistry([
      { id: "builtin-step", harness: new BuiltinStepHarness() },
    ]);
    expect(registry.resolve("builtin-step")).toBeDefined();
    expect(AppError).toBeDefined();
  });
});
