import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";
export const AgentRunParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    input: NonEmptyString,
    session: Type.Object(
      { kind: Type.Literal("main"), agentId: NonEmptyString },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const AgentRunResultSchema = Type.Object(
  { runId: NonEmptyString },
  { additionalProperties: false },
);
export const RunGetParamsSchema = Type.Object(
  { runId: NonEmptyString },
  { additionalProperties: false },
);
export const RunCancelParamsSchema = Type.Object(
  { runId: NonEmptyString },
  { additionalProperties: false },
);
export const SessionHistoryParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);
export const RunJournalParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);
export const RunUsageParamsSchema = Type.Object(
  { runId: NonEmptyString },
  { additionalProperties: false },
);
export const AnyResultSchema = Type.Unknown();
