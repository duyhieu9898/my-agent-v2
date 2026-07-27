import { describe, expect, it } from "vitest";

import {
  createCancellationScope,
  executeAbortable,
  throwIfAborted,
} from "./cancellation.js";
import { nowIso, type Clock } from "./clock.js";
import { createAgentId, createRunId, randomIdFactory } from "./identities.js";
import {
  AppError,
  normalizeError,
  normalizeStorageError,
  toErrorEnvelope,
} from "./errors.js";

describe("core foundation", () => {
  it("keeps runtime identities distinct and validates their values", () => {
    expect(createAgentId("primary")).toBe("primary");
    expect(() => createAgentId("Primary")).toThrow();
    expect(() => createRunId("not-a-uuid")).toThrow();
    expect(randomIdFactory.nextRunId()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("uses an injectable clock", () => {
    const clock: Clock = {
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    };

    expect(nowIso(clock)).toBe("2026-07-24T00:00:00.000Z");
  });

  it("propagates cancellation through AbortSignal", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfAborted(controller.signal)).toThrow(
      "Operation cancelled",
    );
  });

  it("propagates application cancellation through stage and provider boundaries", async () => {
    const application = createCancellationScope();
    const stage = createCancellationScope(application.signal);
    const provider = createCancellationScope(stage.signal);
    let providerSignal: AbortSignal | undefined;

    const pendingProviderCall = executeAbortable(
      provider.signal,
      async (signal) => {
        providerSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throwIfAborted(signal);
        return "unreachable";
      },
    );

    application.cancel();

    await expect(pendingProviderCall).rejects.toThrow("Operation cancelled");
    expect(providerSignal?.aborted).toBe(true);
  });

  it("normalizes storage errors into stable envelopes", () => {
    const normalized = normalizeStorageError(
      new Error("UNIQUE constraint failed: sessions.session_key"),
    );

    expect(normalized).toBeInstanceOf(AppError);
    expect(toErrorEnvelope(normalized)).toEqual({
      code: "STORAGE_CONFLICT",
      message:
        "The requested persistent state conflicts with an existing record",
    });
  });

  it("normalizes every declared boundary without exposing raw errors", () => {
    expect(normalizeError("gateway", new Error("raw"))).toMatchObject({
      code: "GATEWAY_PROTOCOL_ERROR",
      message: "gateway operation failed",
    });
    expect(normalizeError("provider", new Error("raw"))).toMatchObject({
      code: "PROVIDER_REQUEST_FAILED",
      message: "provider operation failed",
    });
    expect(normalizeError("context", new Error("raw"))).toMatchObject({
      code: "CONTEXT_INVALID",
      message: "context operation failed",
    });
    expect(normalizeError("queue", new Error("raw"))).toMatchObject({
      code: "SESSION_RUN_QUEUE_FULL",
      message: "queue operation failed",
    });
    expect(normalizeError("usage", new Error("raw"))).toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
      message: "usage operation failed",
    });
  });
});
