import type { AgentId, SessionId, SessionKey } from "../core/identities.js";

export type SessionEntry = {
  key: SessionKey;
  sessionId: SessionId;
  agentId: AgentId;
  createdAt: string;
  updatedAt: string;
};
