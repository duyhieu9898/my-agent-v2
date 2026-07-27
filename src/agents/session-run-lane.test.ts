import { describe, expect, it } from "vitest";
import { SessionRunLaneCoordinator } from "./session-run-lane.js";
describe("SessionRunLaneCoordinator", () => {
  it("runs accepted work FIFO", async () => {
    const lane = new SessionRunLaneCoordinator(3);
    const events: string[] = [];
    const first = lane.reserve("primary:main");
    const second = lane.reserve("primary:main");
    let resolveSecond: (() => void) | undefined;
    const secondDone = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    first.enqueue(async () => {
      events.push("first");
    });
    second.enqueue(async () => {
      events.push("second");
      resolveSecond?.();
    });
    await secondDone;
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
    let resolveThird: (() => void) | undefined;
    const thirdDone = new Promise<void>((resolve) => {
      resolveThird = resolve;
    });
    for (const value of [1, 2, 3]) {
      lane.reserve("primary:main").enqueue(async () => {
        observed.push(value);
        if (value === 3) resolveThird?.();
      });
    }
    await thirdDone;
    expect(observed).toEqual([1, 2, 3]);
  });
});
