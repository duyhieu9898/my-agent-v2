import AjvModule from "ajv";

const Ajv = AjvModule.default ?? AjvModule;

import {
  GatewayMethods,
  type GatewayMethod,
} from "./schema/methods.js";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});

const validators = Object.fromEntries(
  Object.entries(GatewayMethods).map(([method, definition]) => [
    method,
    ajv.compile(definition.params),
  ]),
) as Record<GatewayMethod, ReturnType<typeof ajv.compile>>;

export type MethodValidationResult =
  | {
      ok: true;
      params: unknown;
    }
  | {
      ok: false;
      errors: string[];
    };

export function isGatewayMethod(
  method: string,
): method is GatewayMethod {
  return method in GatewayMethods;
}

export function validateMethodParams(
  method: GatewayMethod,
  params: unknown,
): MethodValidationResult {
  const validate = validators[method];

  if (validate(params)) {
    return {
      ok: true,
      params,
    };
  }

  return {
    ok: false,
    errors:
      validate.errors?.map((error) => {
        const path = error.instancePath || "/";
        return `${path} ${error.message ?? "is invalid"}`;
      }) ?? ["Invalid method params"],
  };
}