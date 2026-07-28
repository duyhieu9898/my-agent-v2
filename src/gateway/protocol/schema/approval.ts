import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const ApprovalResolveParamsSchema = Type.Object(
  {
    approvalId: NonEmptyString,
    runId: NonEmptyString,
    decision: Type.Union([Type.Literal("allow-once"), Type.Literal("deny")]),
  },
  { additionalProperties: false },
);

export type ApprovalResolveParams = Static<typeof ApprovalResolveParamsSchema>;

export const ApprovalResolveResultSchema = Type.Object(
  {
    approvalId: Type.String(),
    status: Type.Union([
      Type.Literal("allowed"),
      Type.Literal("denied"),
      Type.Literal("already-resolved"),
      Type.Literal("expired"),
      Type.Literal("cancelled"),
      Type.Literal("not-found"),
    ]),
  },
  { additionalProperties: false },
);

export type ApprovalResolveResult = Static<typeof ApprovalResolveResultSchema>;
