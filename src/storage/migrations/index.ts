import { migration001CreateSessions } from "./001-create-sessions.js";
import { migration002CreateTranscriptEntries } from "./002-create-transcript-entries.js";
import { migration003CreateRunJournal } from "./003-create-run-journal.js";
import { migration004CreateRuns } from "./004-create-runs.js";
import { migration005CreateAttempts } from "./005-create-attempts.js";
import { migration006CreateUsageLedger } from "./006-create-usage-ledger.js";
import type { Migration } from "./types.js";

export const migrations: Migration[] = [
  migration001CreateSessions,
  migration002CreateTranscriptEntries,
  migration003CreateRunJournal,
  migration004CreateRuns,
  migration005CreateAttempts,
  migration006CreateUsageLedger,
];
