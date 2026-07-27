import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.js";
import {
  createAttemptId,
  createConnectionId,
  createModelCallId,
  createRunId,
  createSessionId,
  type IdFactory,
} from "../core/identities.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";

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
