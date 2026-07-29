import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDescriptor } from "./contracts.js";
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

    expect(() => registry.register(workspaceListTool)).toThrow(
      "Cannot register tool after registry is frozen",
    );
  });

  it("fails on duplicate tool registration", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);
    expect(() => registry.register(workspaceListTool)).toThrow(
      "Tool 'workspace.list' is already registered",
    );
  });

  it("prevents mutating original descriptor or get()/list() returned reference after registration", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);

    const fetched = registry.get("workspace.list")!;
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(() => {
      (fetched as any).description = "mutated description";
    }).toThrow();

    const list = registry.list();
    expect(Object.isFrozen(list[0])).toBe(true);
  });

  it("computes deterministic fingerprint independent of registration order", () => {
    const reg1 = new ToolRegistry();
    reg1.register(workspaceListTool);
    reg1.register(workspaceReadTextTool);

    const reg2 = new ToolRegistry();
    reg2.register(workspaceReadTextTool);
    reg2.register(workspaceListTool);

    expect(reg1.computeFingerprint()).toBe(reg2.computeFingerprint());
  });

  it("changes fingerprint when security-relevant descriptor metadata changes", () => {
    const registry1 = new ToolRegistry();
    registry1.register(workspaceListTool);
    const fp1 = registry1.computeFingerprint();

    const modifiedTool: ToolDescriptor = {
      ...workspaceListTool,
      timeoutMs: workspaceListTool.timeoutMs + 1000,
    };

    const registry2 = new ToolRegistry();
    registry2.register(modifiedTool);
    const fp2 = registry2.computeFingerprint();

    expect(fp1).not.toBe(fp2);
  });

  it("ignores implementation function identity when computing fingerprint", () => {
    const tool1: ToolDescriptor = {
      ...workspaceListTool,
      execute: async () => ({ value: 1 }),
    };

    const tool2: ToolDescriptor = {
      ...workspaceListTool,
      execute: async () => ({ value: 2 }),
    };

    const reg1 = new ToolRegistry();
    reg1.register(tool1);

    const reg2 = new ToolRegistry();
    reg2.register(tool2);

    expect(reg1.computeFingerprint()).toBe(reg2.computeFingerprint());
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
