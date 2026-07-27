import type { SessionEntry } from "./session-entry.js";

export type CreateSessionInput = {
  key: string;
  agentId: string;
};

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionEntry>;
  getByKey(key: string): Promise<SessionEntry | undefined>;
  list(): Promise<SessionEntry[]>;
  reset(key: string): Promise<SessionEntry | undefined>;
}
