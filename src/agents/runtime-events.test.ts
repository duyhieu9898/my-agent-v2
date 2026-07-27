import { describe, expect, it } from "vitest";
import { toGatewayRuntimeEvent } from "../gateway/runtime-event-translation.js";
import { RuntimeEventBus } from "./runtime-events.js";
describe("RuntimeEventBus", () => {
  it("keeps events bounded and translates them without SDK payloads", () => {
    const bus = new RuntimeEventBus(1);
    bus.emit({
      schemaVersion: 1,
      eventName: "run.accepted",
      occurredAt: "2026-07-24T00:00:00.000Z",
      sourceModule: "agents",
      runId: "run-1",
      payload: { accepted: true },
    });
    const event = bus.snapshot()[0];
    if (!event) throw new Error("Expected event");
    expect(toGatewayRuntimeEvent(event, 1)).toMatchObject({
      type: "event",
      event: "run.accepted",
      seq: 1,
    });
  });
});
