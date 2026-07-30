import { expect } from "vitest";
import { RuntimeEventBus, type RuntimeEvent } from "./runtime-events.js";
import type { RuntimeLifecycleProbe } from "./agent-runtime.js";
import type { SqliteRunStore } from "./run-store.js";

export function collectTerminalEvents(events: RuntimeEventBus): {
  terminal(runId: string): Promise<RuntimeEvent>;
  assertExactlyOne(runId: string): void;
} {
  const buffered: RuntimeEvent[] = [];
  let targetRunId: string | undefined;
  let resolveTerminal: ((event: RuntimeEvent) => void) | undefined;
  const terminalReady = new Promise<RuntimeEvent>((resolve) => {
    resolveTerminal = resolve;
  });
  const isTerminal = (event: RuntimeEvent) =>
    event.eventName === "run.completed" ||
    event.eventName === "run.failed" ||
    event.eventName === "run.cancelled";
  const matching = (runId: string) =>
    buffered.filter((event) => event.runId === runId && isTerminal(event));
  events.subscribe((event) => {
    buffered.push(event);
    if (targetRunId && event.runId === targetRunId && isTerminal(event)) {
      resolveTerminal?.(event);
    }
  });

  return {
    async terminal(runId) {
      targetRunId = runId;
      const existing = matching(runId);
      if (existing.length > 0) {
        return existing[0]!;
      }
      return terminalReady;
    },
    assertExactlyOne(runId) {
      const terminalEvents = events
        .snapshot()
        .filter((event) => event.runId === runId && isTerminal(event));
      if (terminalEvents.length !== 1)
        throw new Error(`Expected exactly one terminal event for ${runId}`);
    },
  };
}

export type TerminalDecision = "complete" | "cancel" | "fail";
export type DurableStatus = "completed" | "cancelled" | "failed";
export type TerminalEventName =
  "run.completed" | "run.cancelled" | "run.failed";

export function terminalFor(
  events: RuntimeEventBus,
  runId: string,
): Promise<RuntimeEvent> {
  const isTerminal = (event: RuntimeEvent) =>
    event.eventName === "run.completed" ||
    event.eventName === "run.failed" ||
    event.eventName === "run.cancelled";
  const existing = events
    .snapshot()
    .find((event) => event.runId === runId && isTerminal(event));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    events.subscribe((event) => {
      if (event.runId === runId && isTerminal(event)) {
        resolve(event);
      }
    });
  });
}

export function createLifecycleTrace(events: RuntimeEventBus): {
  probe: RuntimeLifecycleProbe;
  steps: Array<{ runId: string; step: string }>;
  terminal(runId: string): Promise<RuntimeEvent>;
} {
  const steps: Array<{ runId: string; step: string }> = [];
  return {
    probe: { record: (marker) => steps.push({ ...marker }) },
    steps,
    terminal: (runId) => terminalFor(events, runId),
  };
}

export function assertTerminalTrace(
  trace: ReturnType<typeof createLifecycleTrace>,
  events: RuntimeEventBus,
  runs: SqliteRunStore,
  runId: string,
  expected: {
    decision: TerminalDecision;
    durableStatus: DurableStatus;
    terminalEvent: TerminalEventName;
  },
): Promise<void> {
  const steps = trace.steps
    .filter((entry) => entry.runId === runId)
    .map((entry) => entry.step);
  const count = (step: string) =>
    steps.filter((value) => value === step).length;
  const index = (step: string) => steps.indexOf(step);
  expect(count("run.admitted")).toBe(1);
  expect(count(`checkpoint.decision.${expected.decision}`)).toBe(1);
  expect(index(`checkpoint.decision.${expected.decision}`)).toBeLessThan(
    index("finalize.started"),
  );
  expect(count("finalize.started")).toBe(1);
  expect(count("finalize.completed")).toBe(1);
  expect(count(`run.state.${expected.durableStatus}.committed`)).toBe(1);
  expect(index(`run.state.${expected.durableStatus}.committed`)).toBeLessThan(
    index(`runtime-event.${expected.terminalEvent}.emitted`),
  );
  expect(count(`runtime-event.${expected.terminalEvent}.emitted`)).toBe(1);
  expect(
    events
      .snapshot()
      .filter(
        (event) =>
          event.runId === runId &&
          (event.eventName === "run.completed" ||
            event.eventName === "run.failed" ||
            event.eventName === "run.cancelled"),
      ),
  ).toHaveLength(1);
  return runs.get(runId).then((run) => {
    expect(run?.status).toBe(expected.durableStatus);
  });
}
