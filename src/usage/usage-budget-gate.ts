import { randomUUID } from "node:crypto";

import { AppError } from "../core/errors.js";
import type { AppDatabase } from "../storage/database.js";
import type { NormalizedModelUsage } from "../models/contracts.js";

export type UsagePrice = Readonly<{
  revision: string;
  effectiveFrom?: string;
  providerId: "gemini-developer";
  modelId: "gemini-3.5-flash";
  inputMicrosPerMillionTokens: bigint;
  outputMicrosPerMillionTokens: bigint;
}>;
export type UsageCapPolicy = Readonly<{
  id: string;
  window: "day" | "month";
  maxTokens?: bigint;
  maxCostMicros?: bigint;
  agentId?: string;
  providerId?: "gemini-developer";
  modelId?: "gemini-3.5-flash";
  enabled: boolean;
}>;
export type UsageReservation = Readonly<{
  usageReservationId: string;
  modelCallId: string;
  reservedTokens: bigint;
}>;
export type UsageReservationInput = Readonly<{
  modelCallId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  providerId: "gemini-developer";
  modelId: "gemini-3.5-flash";
  estimatedTokens: bigint;
  occurredAt: string;
}>;

export class UsageBudgetGate {
  public constructor(
    private readonly database: AppDatabase,
    private readonly policies: readonly UsageCapPolicy[],
    private readonly prices: readonly UsagePrice[],
  ) {}

  async reserve(input: UsageReservationInput): Promise<UsageReservation> {
    return this.database.transaction(() => {
      const applicable = this.policies.filter(
        (policy) =>
          policy.enabled &&
          (!policy.agentId || policy.agentId === input.agentId) &&
          (!policy.providerId || policy.providerId === input.providerId) &&
          (!policy.modelId || policy.modelId === input.modelId),
      );
      if (
        applicable.some((policy) => policy.maxCostMicros) &&
        !this.priceFor(input)
      )
        throw new AppError("USAGE_RESERVATION_FAILED", "USAGE_PRICING_UNKNOWN");
      const price = this.priceFor(input);
      const reservedCostMicros = price
        ? (input.estimatedTokens * price.inputMicrosPerMillionTokens) /
          1_000_000n
        : undefined;
      for (const policy of applicable.filter((value) => value.maxTokens)) {
        const windowPrefix = windowStart(input.occurredAt, policy.window);
        const active = this.database
          .prepare(
            `SELECT COALESCE(SUM(CAST(reserved_tokens AS INTEGER)), 0) AS total
             FROM usage_reservations
             WHERE status IN ('reserved', 'dispatched', 'uncertain')
               AND substr(created_at, 1, ?) = ?
               AND (? IS NULL OR agent_id = ?)
               AND (? IS NULL OR provider_id = ?)
               AND (? IS NULL OR model_id = ?)`,
          )
          .get(
            windowPrefix.length,
            windowPrefix,
            policy.agentId ?? null,
            policy.agentId ?? null,
            policy.providerId ?? null,
            policy.providerId ?? null,
            policy.modelId ?? null,
            policy.modelId ?? null,
          ) as {
          total: number;
        };
        const settled = this.database
          .prepare(
            `SELECT COALESCE(SUM(CAST(COALESCE(records.provider_total_tokens,
              CAST(COALESCE(records.input_tokens, '0') AS INTEGER) + CAST(COALESCE(records.output_tokens, '0') AS INTEGER)) AS INTEGER)), 0) AS total
             FROM usage_reservations reservations
             JOIN usage_records records ON records.usage_reservation_id = reservations.usage_reservation_id
             WHERE records.outcome = 'settled'
               AND substr(reservations.created_at, 1, ?) = ?
               AND (? IS NULL OR reservations.agent_id = ?)
               AND (? IS NULL OR reservations.provider_id = ?)
               AND (? IS NULL OR reservations.model_id = ?)`,
          )
          .get(
            windowPrefix.length,
            windowPrefix,
            policy.agentId ?? null,
            policy.agentId ?? null,
            policy.providerId ?? null,
            policy.providerId ?? null,
            policy.modelId ?? null,
            policy.modelId ?? null,
          ) as { total: number };
        if (
          BigInt(active.total) + BigInt(settled.total) + input.estimatedTokens >
          policy.maxTokens!
        )
          throw new AppError("USAGE_RESERVATION_FAILED", "USAGE_CAP_EXCEEDED");
      }
      for (const policy of applicable.filter((value) => value.maxCostMicros)) {
        const windowPrefix = windowStart(input.occurredAt, policy.window);
        const active = this.database
          .prepare(
            `SELECT COALESCE(SUM(CAST(reserved_cost_micros AS INTEGER)), 0) AS total FROM usage_reservations WHERE status IN ('reserved', 'dispatched', 'uncertain') AND substr(created_at, 1, ?) = ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR provider_id = ?) AND (? IS NULL OR model_id = ?)`,
          )
          .get(
            windowPrefix.length,
            windowPrefix,
            policy.agentId ?? null,
            policy.agentId ?? null,
            policy.providerId ?? null,
            policy.providerId ?? null,
            policy.modelId ?? null,
            policy.modelId ?? null,
          ) as { total: number };
        const settled = this.database
          .prepare(
            `SELECT COALESCE(SUM(CAST(records.cost_micros AS INTEGER)), 0) AS total
             FROM usage_reservations reservations
             JOIN usage_records records ON records.usage_reservation_id = reservations.usage_reservation_id
             WHERE records.outcome = 'settled'
               AND substr(reservations.created_at, 1, ?) = ?
               AND (? IS NULL OR reservations.agent_id = ?)
               AND (? IS NULL OR reservations.provider_id = ?)
               AND (? IS NULL OR reservations.model_id = ?)`,
          )
          .get(
            windowPrefix.length,
            windowPrefix,
            policy.agentId ?? null,
            policy.agentId ?? null,
            policy.providerId ?? null,
            policy.providerId ?? null,
            policy.modelId ?? null,
            policy.modelId ?? null,
          ) as { total: number };
        if (
          BigInt(active.total) +
            BigInt(settled.total) +
            (reservedCostMicros ?? 0n) >
          policy.maxCostMicros!
        )
          throw new AppError("USAGE_RESERVATION_FAILED", "USAGE_CAP_EXCEEDED");
      }
      const reservation: UsageReservation = {
        usageReservationId: randomUUID(),
        modelCallId: input.modelCallId,
        reservedTokens: input.estimatedTokens,
      };
      this.database
        .prepare(
          "INSERT INTO usage_reservations (usage_reservation_id, model_call_id, agent_id, session_id, run_id, attempt_id, provider_id, model_id, window_start, reserved_tokens, reserved_cost_micros, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)",
        )
        .run(
          reservation.usageReservationId,
          input.modelCallId,
          input.agentId,
          input.sessionId,
          input.runId,
          input.attemptId,
          input.providerId,
          input.modelId,
          windowStart(input.occurredAt, "day"),
          input.estimatedTokens.toString(),
          reservedCostMicros?.toString() ?? null,
          input.occurredAt,
        );
      return reservation;
    })();
  }

  async markDispatched(
    reservationId: string,
    occurredAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        "UPDATE usage_reservations SET status = 'dispatched', dispatched_at = ? WHERE usage_reservation_id = ? AND status = 'reserved'",
      )
      .run(occurredAt, reservationId);
  }

  async settle(
    reservation: UsageReservation,
    usage: NormalizedModelUsage,
    occurredAt: string,
  ): Promise<void> {
    this.database.transaction(() => {
      const route = this.database
        .prepare(
          "SELECT provider_id, model_id, created_at FROM usage_reservations WHERE usage_reservation_id = ?",
        )
        .get(reservation.usageReservationId) as
        | {
            provider_id: "gemini-developer";
            model_id: "gemini-3.5-flash";
            created_at: string;
          }
        | undefined;
      const price = route
        ? this.prices.find(
            (entry) =>
              entry.providerId === route.provider_id &&
              entry.modelId === route.model_id &&
              (!entry.effectiveFrom || entry.effectiveFrom <= route.created_at),
          )
        : undefined;
      const cost = price ? calculateCost(price, usage) : undefined;
      this.database
        .prepare(
          "UPDATE usage_reservations SET status = 'settled', settled_at = ? WHERE usage_reservation_id = ?",
        )
        .run(occurredAt, reservation.usageReservationId);
      this.database
        .prepare(
          "INSERT INTO usage_records (usage_record_id, usage_reservation_id, outcome, provider_total_tokens, input_tokens, output_tokens, cost_micros, cost_measurement, price_revision, occurred_at) VALUES (?, ?, 'settled', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          reservation.usageReservationId,
          usage.providerTotalTokens?.toString() ?? null,
          usage.inputTokens?.toString() ?? null,
          usage.outputTokens?.toString() ?? null,
          cost?.toString() ?? null,
          cost === undefined ? "unknown" : "derived",
          price?.revision ?? null,
          occurredAt,
        );
    })();
  }

  async release(
    reservation: UsageReservation,
    occurredAt: string,
  ): Promise<void> {
    this.terminal(reservation, "released", occurredAt);
  }
  async markUncertain(
    reservation: UsageReservation,
    occurredAt: string,
  ): Promise<void> {
    this.terminal(reservation, "uncertain", occurredAt);
  }

  async recoverInterrupted(now: string): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE usage_reservations SET status = 'released', settled_at = ? WHERE status = 'reserved' AND dispatched_at IS NULL",
        )
        .run(now);
      this.database
        .prepare(
          "UPDATE usage_reservations SET status = 'uncertain', settled_at = ? WHERE status = 'dispatched'",
        )
        .run(now);
    })();
  }
  private terminal(
    reservation: UsageReservation,
    outcome: "released" | "uncertain",
    occurredAt: string,
  ): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE usage_reservations SET status = ?, settled_at = ? WHERE usage_reservation_id = ?",
        )
        .run(outcome, occurredAt, reservation.usageReservationId);
      this.database
        .prepare(
          "INSERT INTO usage_records (usage_record_id, usage_reservation_id, outcome, cost_measurement, occurred_at) VALUES (?, ?, ?, 'unknown', ?)",
        )
        .run(randomUUID(), reservation.usageReservationId, outcome, occurredAt);
    })();
  }
  private priceFor(input: UsageReservationInput): UsagePrice | undefined {
    return this.prices.find(
      (price) =>
        price.providerId === input.providerId &&
        price.modelId === input.modelId &&
        (!price.effectiveFrom || price.effectiveFrom <= input.occurredAt),
    );
  }
}
function calculateCost(price: UsagePrice, usage: NormalizedModelUsage): bigint {
  return (
    ((usage.inputTokens ?? 0n) * price.inputMicrosPerMillionTokens) /
      1_000_000n +
    ((usage.outputTokens ?? 0n) * price.outputMicrosPerMillionTokens) /
      1_000_000n
  );
}
function windowStart(value: string, window: "day" | "month"): string {
  const date = new Date(value);
  return window === "day"
    ? date.toISOString().slice(0, 10)
    : date.toISOString().slice(0, 7);
}
