import type { GatewayMethodHandler } from "./types.js";
function runtimeDependencies<T>(value: T | undefined): T {
  if (!value) throw new Error("Runtime is unavailable");
  return value;
}
export const handleAgentRun: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => ({
  type: "res",
  id: request.id,
  ok: true,
  payload: await runtimeDependencies(dependencies.runtime).admit(
    request.params as never,
  ),
});
export const handleRunGet: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => ({
  type: "res",
  id: request.id,
  ok: true,
  payload:
    (await runtimeDependencies(dependencies.runs).get(
      (request.params as { runId: string }).runId,
    )) ?? null,
});
export const handleRunCancel: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => ({
  type: "res",
  id: request.id,
  ok: true,
  payload: {
    cancelled: await runtimeDependencies(dependencies.runtime).cancel(
      (request.params as { runId: string }).runId,
    ),
  },
});
export const handleSessionHistory: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const p = request.params as { sessionId: string; limit?: number };
  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: await runtimeDependencies(dependencies.transcripts).readPage(
      p.sessionId,
      { ...(p.limit === undefined ? {} : { limit: p.limit }) },
    ),
  };
};
export const handleRunJournal: GatewayMethodHandler = async ({
  request,
  dependencies,
}) => {
  const p = request.params as { runId: string; limit?: number };
  return {
    type: "res",
    id: request.id,
    ok: true,
    payload: await runtimeDependencies(dependencies.journal).readPage(p.runId, {
      ...(p.limit === undefined ? {} : { limit: p.limit }),
    }),
  };
};
