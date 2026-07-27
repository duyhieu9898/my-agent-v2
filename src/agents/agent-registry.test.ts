import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./agent-registry.js";
describe("AgentRegistry", () => {
  it("resolves one immutable pinned primary snapshot", () => {
    const snapshot = new AgentRegistry().resolve(undefined);
    expect(snapshot.modelRoute.modelId).toBe("gemini-3.5-flash");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => new AgentRegistry().resolve("other")).toThrow(
      "AGENT_NOT_FOUND",
    );
  });
});
