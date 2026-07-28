import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./tool-registry.js";
import { workspaceListTool, workspaceReadTextTool } from "./workspace-tools.js";

describe("ToolRegistry", () => {
  it("registers tools and computes deterministic fingerprints", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);
    registry.register(workspaceReadTextTool);

    expect(registry.get("workspace.list")).toBe(workspaceListTool);
    expect(registry.get("workspace.read_text")).toBe(workspaceReadTextTool);

    const fp1 = registry.computeFingerprint();
    expect(fp1).toHaveLength(64);

    registry.freeze();
    expect(registry.isFrozen()).toBe(true);

    expect(() => registry.register(workspaceListTool)).toThrow();
  });

  it("validates tool arguments and results using AJV schemas", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);

    const validArgs = registry.validateArguments("workspace.list", {
      path: "src",
    });
    expect(validArgs.ok).toBe(true);

    const invalidArgs = registry.validateArguments("workspace.list", {
      path: 123,
    });
    expect(invalidArgs.ok).toBe(false);
  });
});
