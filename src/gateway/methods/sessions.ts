import type {
  SessionsCreateParams,
  SessionsDescribeParams,
  SessionsResolveParams,
} from "../protocol/schema/sessions.js";
import type { GatewayMethodHandler } from "./types.js";

export const handleSessionsCreate: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const params = request.params as SessionsCreateParams;
  const session = await dependencies.sessions.create({
    key: params.key,
    agentId: params.agentId ?? "primary",
  });

  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: session,
  };
};

export const handleSessionsDescribe: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const params = request.params as SessionsDescribeParams;
  const session = await dependencies.sessions.getByKey(params.key);

  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: session ?? null,
  };
};

export const handleSessionsResolve: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const params = request.params as SessionsResolveParams;

  const session = await dependencies.sessionResolver.resolve(params);

  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: session,
  };
};

export const handleSessionsList: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const sessions = await dependencies.sessions.list();

  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: {
      sessions,
    },
  };
};
