import AjvModule from "ajv";

const Ajv = AjvModule.default ?? AjvModule;

import {
  GatewayFrameSchema,
  type GatewayFrame,
} from "./schema/frames.js";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});

const validateGatewayFrameSchema =
  ajv.compile<GatewayFrame>(GatewayFrameSchema);

export type FrameValidationResult =
  | {
      ok: true;
      frame: GatewayFrame;
    }
  | {
      ok: false;
      errors: string[];
    };

export function validateGatewayFrame(
  value: unknown,
): FrameValidationResult {
  if (validateGatewayFrameSchema(value)) {
    return {
      ok: true,
      frame: value,
    };
  }

  return {
    ok: false,
    errors:
      validateGatewayFrameSchema.errors?.map((error) => {
        const path = error.instancePath || "/";
        return `${path} ${error.message ?? "is invalid"}`;
      }) ?? ["Invalid Gateway frame"],
  };
}