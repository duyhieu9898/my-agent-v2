import { randomUUID } from "node:crypto";

type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type AgentId = Brand<string, "AgentId">;
export type SessionKey = Brand<string, "SessionKey">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type AttemptId = Brand<string, "AttemptId">;
export type ModelCallId = Brand<string, "ModelCallId">;
export type ConnectionId = Brand<string, "ConnectionId">;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const agentIdPattern = /^[a-z0-9][a-z0-9._-]*$/;

function requireUuid<Name extends string>(
  value: string,
  name: Name,
): Brand<string, Name> {
  if (!uuidPattern.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }

  return value as Brand<string, Name>;
}

export function createAgentId(value: string): AgentId {
  if (!agentIdPattern.test(value)) {
    throw new Error("AgentId must be a lowercase canonical identifier");
  }

  return value as AgentId;
}

export function createSessionKey(value: string): SessionKey {
  if (!value.startsWith("agent:") || value.trim() !== value) {
    throw new Error("SessionKey must be canonical and begin with agent:");
  }

  return value as SessionKey;
}

export const createSessionId = (value: string): SessionId =>
  requireUuid(value, "SessionId");
export const createRunId = (value: string): RunId =>
  requireUuid(value, "RunId");
export const createAttemptId = (value: string): AttemptId =>
  requireUuid(value, "AttemptId");
export const createModelCallId = (value: string): ModelCallId =>
  requireUuid(value, "ModelCallId");
export const createConnectionId = (value: string): ConnectionId =>
  requireUuid(value, "ConnectionId");

export interface IdFactory {
  nextSessionId(): SessionId;
  nextRunId(): RunId;
  nextAttemptId(): AttemptId;
  nextModelCallId(): ModelCallId;
  nextConnectionId(): ConnectionId;
}

function nextUuid(): string {
  return randomUUID();
}

export const randomIdFactory: IdFactory = {
  nextSessionId: () => createSessionId(nextUuid()),
  nextRunId: () => createRunId(nextUuid()),
  nextAttemptId: () => createAttemptId(nextUuid()),
  nextModelCallId: () => createModelCallId(nextUuid()),
  nextConnectionId: () => createConnectionId(nextUuid()),
};
