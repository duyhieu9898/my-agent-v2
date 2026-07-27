import { describe, expect, it } from "vitest";
import { RuntimeCapacity } from "./runtime-capacity.js";
describe("RuntimeCapacity", () => {
  it("limits model permits independently of session lanes", async () => {
    const capacity = new RuntimeCapacity(1);
    const first = await capacity.acquire();
    let second = false;
    const pending = capacity.acquire().then((release) => {
      second = true;
      release();
    });
    expect(second).toBe(false);
    first();
    await pending;
    expect(second).toBe(true);
  });
});
