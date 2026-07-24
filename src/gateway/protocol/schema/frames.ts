import { Type, type Static } from "typebox";

import { NonEmptyString } from "./primitives.js";

export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  {
    additionalProperties: false,
  },
);

export type RequestFrame = Static<typeof RequestFrameSchema>;

export const GatewayErrorSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
  },
  {
    additionalProperties: false,
  },
);

export type GatewayError = Static<typeof GatewayErrorSchema>;

export const ResponseFrameSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("res"),
      id: NonEmptyString,
      ok: Type.Literal(true),
      payload: Type.Optional(Type.Unknown()),
    },
    {
      additionalProperties: false,
    },
  ),

  Type.Object(
    {
      type: Type.Literal("res"),
      id: NonEmptyString,
      ok: Type.Literal(false),
      error: GatewayErrorSchema,
    },
    {
      additionalProperties: false,
    },
  ),
]);

export type ResponseFrame = Static<typeof ResponseFrameSchema>;

export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  {
    additionalProperties: false,
  },
);

export type EventFrame = Static<typeof EventFrameSchema>;

export const GatewayFrameSchema = Type.Union([
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
]);

export type GatewayFrame = Static<typeof GatewayFrameSchema>;