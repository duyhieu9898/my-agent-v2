import { describe, expect, it } from "vitest";
import { CheckpointStage, FinalizeStage } from "./lifecycle.js";
describe("lifecycle stages", () => {
  it("keeps terminal authority in CheckpointStage and finalizes once", async () => {
    const checkpoint = new CheckpointStage();
    expect(
      checkpoint.decide({ cancelled: false, result: { kind: "ok" } }),
    ).toBe("complete");
    expect(checkpoint.decide({ cancelled: true, result: { kind: "ok" } })).toBe(
      "cancel",
    );
    const finalize = new FinalizeStage();
    let calls = 0;
    await finalize.execute(async () => {
      calls += 1;
    });
    await finalize.execute(async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});
