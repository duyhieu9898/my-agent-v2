import { Type, type Static } from "typebox";

import { NonEmptyString } from "./primitives.js";

export const SessionEntrySchema = Type.Object(
  {
    key: Type.String(),
    sessionId: Type.String(),
    agentId: Type.String(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  {
    additionalProperties: false,
  },
);

export type SessionEntrySchemaType = Static<typeof SessionEntrySchema>;

// sessions.create
export const SessionsCreateParamsSchema = Type.Object(
  {
    key: Type.String(),
    agentId: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);
export type SessionsCreateParams = Static<typeof SessionsCreateParamsSchema>;

export const SessionsCreateResultSchema = SessionEntrySchema;
export type SessionsCreateResult = Static<typeof SessionsCreateResultSchema>;

// sessions.describe
export const SessionsDescribeParamsSchema = Type.Object(
  {
    key: Type.String(),
  },
  {
    additionalProperties: false,
  },
);
export type SessionsDescribeParams = Static<
  typeof SessionsDescribeParamsSchema
>;

export const SessionsDescribeResultSchema = Type.Union([
  SessionEntrySchema,
  Type.Null(),
]);
export type SessionsDescribeResult = Static<
  typeof SessionsDescribeResultSchema
>;

// sessions.resolve
export const SessionsResolveParamsSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("main"),
      agentId: NonEmptyString,
    },
    { additionalProperties: false },
  ),

  Type.Object(
    {
      kind: Type.Literal("channel"),
      agentId: NonEmptyString,
      channel: NonEmptyString,
      conversationId: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);

export type SessionsResolveParams = Static<typeof SessionsResolveParamsSchema>;

export const SessionsResolveResultSchema = SessionEntrySchema;
export type SessionsResolveResult = Static<typeof SessionsResolveResultSchema>;

// sessions.list
export const SessionsListParamsSchema = Type.Object(
  {},
  {
    additionalProperties: false,
  },
);
export type SessionsListParams = Static<typeof SessionsListParamsSchema>;

export const SessionsListResultSchema = Type.Object(
  {
    sessions: Type.Array(SessionEntrySchema),
  },
  {
    additionalProperties: false,
  },
);
export type SessionsListResult = Static<typeof SessionsListResultSchema>;
