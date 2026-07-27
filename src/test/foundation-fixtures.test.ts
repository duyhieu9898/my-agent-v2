import { afterEach, describe, expect, it } from "vitest";

import {
  createEventCollector,
  createRunJournalCollector,
  createSequentialIdFactory,
  createTemporaryDatabase,
  FakeClock,
} from "./foundation-fixtures.js";

let temporaryDatabase: ReturnType<typeof createTemporaryDatabase> | undefined;

afterEach(() => {
  temporaryDatabase?.close();
  temporaryDatabase = undefined;
});

describe("foundation fixtures", () => {
  it("provides deterministic time, IDs, events, and temporary SQLite", () => {
    const clock = new FakeClock(new Date("2026-07-24T00:00:00.000Z"));
    clock.advance(1_000);
    const ids = createSequentialIdFactory();
    const collector = createEventCollector<{ type: string }>();
    const journal = createRunJournalCollector<{
      runId: string;
      sequence: number;
    }>();
    temporaryDatabase = createTemporaryDatabase();

    collector.emit({ type: "run.accepted" });
    journal.append({ runId: "run-1", sequence: 1 });

    expect(clock.now().toISOString()).toBe("2026-07-24T00:00:01.000Z");
    expect(ids.nextRunId()).toBe("00000000-0000-4000-8000-000000000001");
    expect(collector.events).toEqual([{ type: "run.accepted" }]);
    expect(journal.entries).toEqual([{ runId: "run-1", sequence: 1 }]);
    expect(temporaryDatabase.database.open).toBe(true);
  });
});
