import { describe, expect, it } from "vitest";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
describe("SessionRunLaneCoordinator", () => {
  it("runs accepted work FIFO", async () => {
    const lane = new SessionRunLaneCoordinator(3);
    const events: string[] = [];
    const first = lane.reserve("primary:main");
    const second = lane.reserve("primary:main");
    first.enqueue(async () => {
      events.push("first");
    });
    second.enqueue(async () => {
      events.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first", "second"]);
  });
  it("rejects before enqueue when full", () => {
    const lane = new SessionRunLaneCoordinator(1);
    lane.reserve("primary:main");
    expect(() => lane.reserve("primary:main")).toThrow(
      "Session run queue is full",
    );
  });

  it("keeps three same-session runs in arrival order", async () => {
    const lane = new SessionRunLaneCoordinator(3);
    const observed: number[] = [];
    for (const value of [1, 2, 3]) {
      lane.reserve("primary:main").enqueue(async () => {
        observed.push(value);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual([1, 2, 3]);
  });
});
