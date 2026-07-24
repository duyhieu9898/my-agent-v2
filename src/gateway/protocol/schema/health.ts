import { Type, type Static } from "typebox";

export const HealthParamsSchema = Type.Object(
  {},
  {
    additionalProperties: false,
  },
);

export type HealthParams = Static<typeof HealthParamsSchema>;

export const HealthResultSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    uptimeMs: Type.Integer({ minimum: 0 }),
    protocol: Type.Integer({ minimum: 1 }),
  },
  {
    additionalProperties: false,
  },
);

export type HealthResult = Static<typeof HealthResultSchema>;