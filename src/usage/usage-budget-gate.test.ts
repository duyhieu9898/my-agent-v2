import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { createTemporaryDatabase } from "../test/foundation-fixtures.js";
import { UsageBudgetGate } from "./usage-budget-gate.js";

let database: AppDatabase;
beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database);
});
afterEach(() => database.close());
const input = (modelCallId: string) => ({
  modelCallId,
  agentId: "primary",
  sessionId: "session",
  runId: "run",
  attemptId: "attempt",
  providerId: "gemini-developer" as const,
  modelId: "gemini-3.5-flash" as const,
  estimatedTokens: 10n,
  occurredAt: "2026-07-24T00:00:00.000Z",
});
describe("UsageBudgetGate", () => {
  it("atomically reserves before dispatch and settles after response", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "day", window: "day", maxTokens: 10n, enabled: true }],
      [],
    );
    const reservation = await gate.reserve(input("call-1"));
    await gate.markDispatched(
      reservation.usageReservationId,
      input("x").occurredAt,
    );
    await gate.settle(
      reservation,
      { providerTotalTokens: 7n, measurement: "provider-exact" },
      input("x").occurredAt,
    );
    await expect(gate.reserve(input("call-2"))).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
  });
  it("persists a derived integer cost and immutable price revision", async () => {
    const gate = new UsageBudgetGate(
      database,
      [],
      [
        {
          revision: "price-1",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          inputMicrosPerMillionTokens: 1_000_000n,
          outputMicrosPerMillionTokens: 2_000_000n,
        },
      ],
    );
    const reservation = await gate.reserve(input("call-1"));
    await gate.settle(
      reservation,
      { inputTokens: 3n, outputTokens: 2n, measurement: "provider-exact" },
      input("x").occurredAt,
    );
    expect(
      database
        .prepare(
          "SELECT cost_micros, price_revision, cost_measurement FROM usage_records",
        )
        .get(),
    ).toEqual({
      cost_micros: "7",
      price_revision: "price-1",
      cost_measurement: "derived",
    });
  });
  it("does not reserve against a future price revision", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "cost", window: "day", maxCostMicros: 1n, enabled: true }],
      [
        {
          revision: "future",
          effectiveFrom: "2027-01-01T00:00:00.000Z",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          inputMicrosPerMillionTokens: 1n,
          outputMicrosPerMillionTokens: 1n,
        },
      ],
    );
    await expect(gate.reserve(input("call"))).rejects.toThrow(
      "USAGE_PRICING_UNKNOWN",
    );
  });
  it("rejects a cap before provider dispatch", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "day", window: "day", maxTokens: 10n, enabled: true }],
      [],
    );
    await gate.reserve(input("call-1"));
    await expect(gate.reserve(input("call-2"))).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
  });
  it("counts multiple settled calls and active reservations without double counting", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "day", window: "day", maxTokens: 30n, enabled: true }],
      [],
    );
    const first = await gate.reserve(input("call-1"));
    await gate.markDispatched(first.usageReservationId, input("x").occurredAt);
    await gate.settle(
      first,
      { providerTotalTokens: 7n, measurement: "provider-exact" },
      input("x").occurredAt,
    );
    const second = await gate.reserve(input("call-2"));
    await gate.markDispatched(second.usageReservationId, input("x").occurredAt);
    await gate.settle(
      second,
      { providerTotalTokens: 8n, measurement: "provider-exact" },
      input("x").occurredAt,
    );
    await gate.reserve(input("call-3"));
    await expect(gate.reserve(input("call-4"))).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
  });
  it("retains uncertain usage and releases proven-undispatched headroom", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "day", window: "day", maxTokens: 10n, enabled: true }],
      [],
    );
    const released = await gate.reserve(input("released"));
    await gate.release(released, input("x").occurredAt);
    const uncertain = await gate.reserve(input("uncertain"));
    await gate.markDispatched(
      uncertain.usageReservationId,
      input("x").occurredAt,
    );
    await gate.markUncertain(uncertain, input("x").occurredAt);
    await expect(gate.reserve(input("blocked"))).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
  });
  it("keeps an ambiguous dispatched reservation in cap headroom after reopen", async () => {
    const temporary = createTemporaryDatabase();
    migrateDatabase(temporary.database);
    const policy = [
      { id: "day", window: "day" as const, maxTokens: 10n, enabled: true },
    ];
    const beforeRestart = new UsageBudgetGate(temporary.database, policy, []);
    const reservation = await beforeRestart.reserve(input("ambiguous"));
    await beforeRestart.markDispatched(
      reservation.usageReservationId,
      input("x").occurredAt,
    );
    await beforeRestart.markUncertain(reservation, input("x").occurredAt);
    temporary.database.close();
    const reopened = openDatabase(temporary.path);
    migrateDatabase(reopened);
    const afterRestart = new UsageBudgetGate(reopened, policy, []);
    await expect(
      afterRestart.reserve(input("blocked-after-reopen")),
    ).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
    reopened.close();
    temporary.close();
  });
  it("applies cap totals only within the policy scope and UTC window", async () => {
    const gate = new UsageBudgetGate(
      database,
      [
        {
          id: "primary",
          window: "month",
          agentId: "primary",
          maxTokens: 10n,
          enabled: true,
        },
      ],
      [],
    );
    await gate.reserve(input("call-1"));
    await expect(
      gate.reserve({ ...input("call-2"), agentId: "other" }),
    ).resolves.toBeDefined();
    await expect(
      gate.reserve({
        ...input("call-3"),
        occurredAt: "2026-08-01T00:00:00.000Z",
      }),
    ).resolves.toBeDefined();
  });
  it("fails closed when a cost cap has no compatible price", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "cost", window: "day", maxCostMicros: 1n, enabled: true }],
      [],
    );
    await expect(gate.reserve(input("call-1"))).rejects.toThrow(
      "USAGE_PRICING_UNKNOWN",
    );
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM usage_reservations")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
  it("rejects a cost cap before dispatch using the reserved price estimate", async () => {
    const gate = new UsageBudgetGate(
      database,
      [{ id: "cost", window: "day", maxCostMicros: 10n, enabled: true }],
      [
        {
          revision: "p",
          providerId: "gemini-developer",
          modelId: "gemini-3.5-flash",
          inputMicrosPerMillionTokens: 1_000_000n,
          outputMicrosPerMillionTokens: 0n,
        },
      ],
    );
    await gate.reserve(input("call-1"));
    await expect(gate.reserve(input("call-2"))).rejects.toMatchObject({
      code: "USAGE_RESERVATION_FAILED",
    });
  });
  it("releases only proven-undispatched reservations during recovery", async () => {
    const gate = new UsageBudgetGate(database, [], []);
    const undispatched = await gate.reserve(input("call-1"));
    const dispatched = await gate.reserve(input("call-2"));
    await gate.markDispatched(
      dispatched.usageReservationId,
      input("x").occurredAt,
    );
    await gate.recoverInterrupted("2026-07-24T01:00:00.000Z");
    const rows = database
      .prepare("SELECT status FROM usage_reservations ORDER BY model_call_id")
      .all() as Array<{ status: string }>;
    expect(rows.map((row) => row.status)).toEqual(["released", "uncertain"]);
    expect(undispatched.usageReservationId).toBeDefined();
  });
});
