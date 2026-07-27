import { describe, expect, it } from "vitest";

import { validateGatewayFrame } from "./validate-frame.js";

describe("validateGatewayFrame", () => {
  it("accepts a valid request frame", () => {
    const result = validateGatewayFrame({
      type: "req",
      id: "req-1",
      method: "health",
      params: {},
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a valid response frame", () => {
    const result = validateGatewayFrame({
      type: "res",
      id: "req-1",
      ok: true,
      payload: {
        status: "ok",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a valid event frame", () => {
    const result = validateGatewayFrame({
      type: "event",
      event: "run.started",
      seq: 1,
      payload: {
        runId: "run-1",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a request without id", () => {
    const result = validateGatewayFrame({
      type: "req",
      method: "health",
      params: {},
    });

    expect(result.ok).toBe(false);
  });

  it("rejects additional properties", () => {
    const result = validateGatewayFrame({
      type: "req",
      id: "req-1",
      method: "health",
      params: {},
      unexpected: true,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an unknown frame type", () => {
    const result = validateGatewayFrame({
      type: "unknown",
    });

    expect(result.ok).toBe(false);
  });
});
