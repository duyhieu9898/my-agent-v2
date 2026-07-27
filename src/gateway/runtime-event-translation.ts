import type { RuntimeEvent } from "../agents/runtime-events.js";
import type { EventFrame } from "./protocol/schema/frames.js";
export function toGatewayRuntimeEvent(
  event: RuntimeEvent,
  seq: number,
): EventFrame {
  return {
    type: "event",
    event: event.eventName,
    payload: {
      occurredAt: event.occurredAt,
      sourceModule: event.sourceModule,
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      runId: event.runId,
      attemptId: event.attemptId,
      modelCallId: event.modelCallId,
      ...event.payload,
    },
    seq,
  };
}
