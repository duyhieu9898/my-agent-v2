import { migration001CreateSessions } from "./001-create-sessions.js";
import type { Migration } from "./types.js";

export const migrations: Migration[] = [
  migration001CreateSessions,
];
