import { Type } from "typebox";

export const NonEmptyString = Type.String({
  minLength: 1,
});