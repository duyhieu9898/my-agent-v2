import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolDescriptor, ToolRegistration } from "./contracts.js";
import { canonicalJsonStringify, strictJsonSnapshot } from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";
import { workspaceListTool, workspaceReadTextTool } from "./workspace-tools.js";

describe("ToolRegistry", () => {
  it("registers tools and computes deterministic fingerprints", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);
    registry.register(workspaceReadTextTool);

    expect(registry.get("workspace.list")?.name).toBe("workspace.list");
    expect(registry.get("workspace.read_text")?.name).toBe(
      "workspace.read_text",
    );

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

  it("proves caller descriptor/schema mutation after registration does not affect stored registry authority or fingerprint", () => {
    const registry = new ToolRegistry();

    // Create a mutable descriptor with nested schemas and rules
    const rawSchema = Type.Object({ path: Type.String() });
    const rawRedaction = ["secret_rule"];
    const mutableDescriptor: ToolRegistration = {
      ...workspaceListTool,
      name: "test.mutable",
      argumentSchema: rawSchema,
      redactionRules: rawRedaction,
      inputLimits: { maxBytes: 500 },
    };

    registry.register(mutableDescriptor);
    const fpBefore = registry.computeToolFingerprint(
      registry.get("test.mutable")!,
    );

    // Mutate original caller objects
    (rawSchema as any).properties.path.type = "number";
    rawRedaction.push("new_rule");
    mutableDescriptor.description = "hacked description";
    mutableDescriptor.inputLimits.maxBytes = 999999;

    const stored = registry.get("test.mutable")!;
    expect(stored.description).toBe(
      "Bounded directory listing within the agent workspace. Returns sorted entries.",
    );
    expect(stored.redactionRules).toEqual(["secret_rule"]);
    expect(stored.inputLimits.maxBytes).toBe(500);

    const fpAfter = registry.computeToolFingerprint(stored);
    expect(fpBefore).toBe(fpAfter);
  });

  it("ensures returned descriptors and all nested structures are deeply frozen", () => {
    const registry = new ToolRegistry();
    registry.register(workspaceListTool);

    const fetched = registry.get("workspace.list")!;
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(Object.isFrozen(fetched.redactionRules)).toBe(true);
    expect(Object.isFrozen(fetched.inputLimits)).toBe(true);
    expect(Object.isFrozen(fetched.outputLimits)).toBe(true);

    expect(() => {
      (fetched as any).description = "mutated description";
    }).toThrow();

    expect(() => {
      (fetched.redactionRules as any).push("hacked");
    }).toThrow();

    const list = registry.list();
    expect(Object.isFrozen(list[0])).toBe(true);
  });

  it("computes identical fingerprints for equivalent nested objects regardless of key insertion order", () => {
    const reg1 = new ToolRegistry();
    const tool1: ToolRegistration = {
      ...workspaceListTool,
      name: "test.order1",
      argumentSchema: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
      },
    };
    reg1.register(tool1);

    const reg2 = new ToolRegistry();
    const tool2: ToolRegistration = {
      ...workspaceListTool,
      name: "test.order1",
      argumentSchema: {
        type: "object",
        properties: { b: { type: "number" }, a: { type: "string" } },
      },
    };
    reg2.register(tool2);

    expect(reg1.computeFingerprint()).toBe(reg2.computeFingerprint());
  });

  it("changes fingerprint when nested security metadata or approval renderer version changes", () => {
    const reg1 = new ToolRegistry();
    reg1.register(workspaceListTool);
    const fp1 = reg1.computeFingerprint();

    const modifiedTool1: ToolRegistration = {
      ...workspaceListTool,
      redactionRules: ["rule_1"],
    };
    const reg2 = new ToolRegistry();
    reg2.register(modifiedTool1);
    expect(reg2.computeFingerprint()).not.toBe(fp1);

    const modifiedTool2: ToolRegistration = {
      ...workspaceListTool,
      approvalSummaryRendererVersion: "2.0.0",
    };
    const reg3 = new ToolRegistry();
    reg3.register(modifiedTool2);
    expect(reg3.computeFingerprint()).not.toBe(fp1);
  });

  it("ignores implementation function identity and renderer function identity when stable metadata is unchanged", () => {
    const tool1: ToolRegistration = {
      ...workspaceListTool,
      approvalSummaryRendererVersion: "1.0.0",
      approvalSummaryRenderer: () => "Summary A",
      execute: async () => ({ value: 1 }),
    };

    const tool2: ToolRegistration = {
      ...workspaceListTool,
      approvalSummaryRendererVersion: "1.0.0",
      approvalSummaryRenderer: () => "Summary B",
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

  it("proves get() and list() do not expose executable or renderer functions, but internal registry operation retains execution authority", async () => {
    const registry = new ToolRegistry();
    let executed = false;

    const tool: ToolRegistration = {
      ...workspaceListTool,
      name: "test.secret",
      approvalSummaryRenderer: (args: any) => `Secret action: ${args.path}`,
      execute: async () => {
        executed = true;
        return {
          path: "secret",
          entries: [],
          returnedCount: 0,
          hasMore: false,
        };
      },
    };

    registry.register(tool);

    const getDescriptor = registry.get("test.secret")!;
    expect((getDescriptor as any).execute).toBeUndefined();
    expect((getDescriptor as any).approvalSummaryRenderer).toBeUndefined();

    const listDescriptors = registry.list();
    const item = listDescriptors.find((d) => d.name === "test.secret")!;
    expect((item as any).execute).toBeUndefined();
    expect((item as any).approvalSummaryRenderer).toBeUndefined();

    const internalImpl = registry.getInternalImplementation("test.secret")!;
    expect(internalImpl).toBeDefined();
    expect(internalImpl.approvalSummaryRenderer({ path: "x" })).toBe(
      "Secret action: x",
    );

    await internalImpl.execute({ path: "x" }, {} as any);
    expect(executed).toBe(true);
  });

  it("strictly tests strictJsonSnapshot and canonicalJsonStringify requirements", () => {
    // Rejections
    expect(() => strictJsonSnapshot(undefined)).toThrow();
    expect(() => strictJsonSnapshot({ a: undefined })).toThrow();
    expect(() => strictJsonSnapshot(() => {})).toThrow();
    expect(() => strictJsonSnapshot(Symbol("test"))).toThrow();
    expect(() => strictJsonSnapshot(10n)).toThrow();
    expect(() => strictJsonSnapshot(NaN)).toThrow();
    expect(() => strictJsonSnapshot(Infinity)).toThrow();
    expect(() => strictJsonSnapshot(-Infinity)).toThrow();

    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => strictJsonSnapshot(cyclic)).toThrow();

    class CustomClass {}
    expect(() => strictJsonSnapshot(new CustomClass())).toThrow();

    // Canonical key sorting & array order preservation
    const objA = { b: 2, a: 1, nested: { z: 10, y: 5 } };
    const objB = { nested: { y: 5, z: 10 }, a: 1, b: 2 };
    expect(canonicalJsonStringify(objA)).toBe(canonicalJsonStringify(objB));

    const arr = [3, 1, 2];
    const snapshotArr = strictJsonSnapshot(arr);
    expect(snapshotArr).toEqual([3, 1, 2]);
    expect(Object.isFrozen(snapshotArr)).toBe(true);

    const validData = { x: [1, 2, { y: "hello" }] };
    const snapshotData = strictJsonSnapshot(validData);
    expect(Object.isFrozen(snapshotData)).toBe(true);
    expect(Object.isFrozen(snapshotData.x)).toBe(true);
    expect(Object.isFrozen(snapshotData.x[2])).toBe(true);
    expect(snapshotData).not.toBe(validData); // detached
  });
});
