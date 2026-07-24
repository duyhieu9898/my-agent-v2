export type SessionKeyInput =
  | {
      kind: "main";
      agentId: string;
    }
  | {
      kind: "channel";
      agentId: string;
      channel: string;
      conversationId: string;
    };

function normalizeSegment(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    throw new Error("Session key segment must not be empty");
  }

  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid session key segment: ${value}`);
  }

  return normalized;
}

export function createSessionKey(input: SessionKeyInput): string {
  const agentId = normalizeSegment(input.agentId);

  if (input.kind === "main") {
    return `agent:${agentId}:main`;
  }

  const channel = normalizeSegment(input.channel);
  const conversationId = normalizeSegment(input.conversationId);

  return `agent:${agentId}:${channel}:${conversationId}`;
}
