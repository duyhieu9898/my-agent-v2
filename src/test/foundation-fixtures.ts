import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.js";
import {
  createApprovalId,
  createAttemptId,
  createConnectionId,
  createModelCallId,
  createRunId,
  createSessionId,
  createToolCallId,
  type IdFactory,
} from "../core/identities.js";
import {
  AgentRegistry,
  type AgentDefinition,
} from "../agents/agent-registry.js";
import { BuiltinStepHarness } from "../agents/harness.js";
import { HarnessRegistry } from "../agents/harness-registry.js";
import { HeuristicTokenEstimator } from "../models/token-estimator.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";

/**
 * The default primary agent definition used by deterministic runtime fixtures.
 * Mirrors the bootstrap-composed definition so tests exercise snapshot-driven
 * execution without reintroducing production fallbacks.
 */
export const primaryAgentDefinition: AgentDefinition = {
  agentId: "primary",
  agentRevision: "primary-v1",
  modelRoute: { providerId: "gemini-developer", modelId: "gemini-3.5-flash" },
  harnessId: "builtin-step",
  promptProfile: "main-v1",
  toolProfile: "none",
  memoryProfile: "none",
  toolRegistryFingerprint: "none",
  toolPolicyFingerprint: "none",
  sandboxPolicyFingerprint: "none",
  memoryPolicyFingerprint: "none",
  contextTokenBudget: 12000,
  tokenEstimatorRevision: "heuristic-v1",
  availability: "ready",
};

/**
 * Deterministic runtime authority dependencies (agent registry, harness
 * registry, token estimator) for tests that construct `AgentRuntime` directly.
 * Production composes equivalents in bootstrap; tests use this helper instead of
 * a production fallback.
 */
export function createRuntimeAuthority(): {
  agentRegistry: AgentRegistry;
  harnessRegistry: HarnessRegistry;
  tokenEstimator: HeuristicTokenEstimator;
} {
  return {
    agentRegistry: new AgentRegistry([primaryAgentDefinition]),
    harnessRegistry: new HarnessRegistry([
      { id: "builtin-step", harness: new BuiltinStepHarness() },
    ]),
    tokenEstimator: new HeuristicTokenEstimator(),
  };
}

export class FakeClock implements Clock {
  public constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function deterministicUuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

export function createSequentialIdFactory(): IdFactory {
  let sequence = 0;
  const next = (): string => deterministicUuid(++sequence);

  return {
    nextSessionId: () => createSessionId(next()),
    nextRunId: () => createRunId(next()),
    nextAttemptId: () => createAttemptId(next()),
    nextModelCallId: () => createModelCallId(next()),
    nextConnectionId: () => createConnectionId(next()),
    nextToolCallId: () => createToolCallId(`tcall_${next()}`),
    nextApprovalId: () => createApprovalId(`appr_${next()}`),
  };
}

export function createTemporaryDatabase(): {
  database: AppDatabase;
  path: string;
  close(): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "my-agent-test-"));
  const path = join(directory, "agent.sqlite");
  const database = openDatabase(path);

  return {
    database,
    path,
    close() {
      if (database.open) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function createEventCollector<Event>(): {
  events: readonly Event[];
  emit(event: Event): void;
} {
  const events: Event[] = [];

  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

export function createRunJournalCollector<
  Entry extends { runId: string; sequence: number },
>(): {
  entries: readonly Entry[];
  append(entry: Entry): void;
} {
  const entries: Entry[] = [];

  return {
    entries,
    append(entry) {
      const previous = entries.at(-1);

      if (
        previous &&
        (previous.runId !== entry.runId || entry.sequence <= previous.sequence)
      ) {
        throw new Error(
          "Run Journal collector requires one monotonic run sequence",
        );
      }

      entries.push(entry);
    },
  };
}
