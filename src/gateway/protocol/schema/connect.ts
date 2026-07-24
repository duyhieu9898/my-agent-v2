import { Type, type Static } from "typebox";

import { NonEmptyString } from "./primitives.js";

export const ClientModeSchema = Type.Union([
  Type.Literal("web"),
  Type.Literal("cli"),
]);

export type ClientMode = Static<typeof ClientModeSchema>;

export const ConnectParamsSchema = Type.Object(
  {
    minProtocol: Type.Integer({ minimum: 1 }),
    maxProtocol: Type.Integer({ minimum: 1 }),

    client: Type.Object(
      {
        name: NonEmptyString,
        version: NonEmptyString,
        mode: ClientModeSchema,
      },
      {
        additionalProperties: false,
      },
    ),
  },
  {
    additionalProperties: false,
  },
);

export type ConnectParams = Static<typeof ConnectParamsSchema>;

export const ConnectResultSchema = Type.Object(
  {
    protocol: Type.Integer({ minimum: 1 }),

    gateway: Type.Object(
      {
        name: NonEmptyString,
        version: NonEmptyString,
      },
      {
        additionalProperties: false,
      },
    ),
  },
  {
    additionalProperties: false,
  },
);

export type ConnectResult = Static<typeof ConnectResultSchema>;