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
  revision?: string | number;
  window: "day" | "month";
  maxTokens?: bigint;
  maxCostMicros?: bigint;
  agentId?: string;
  providerId?: "gemini-developer";
  modelId?: "gemini-3.5-flash";
  enabled: boolean;
  ruleMetadata?: Readonly<Record<string, string | number | boolean | null>>;
}>;
export type UsageReservation = Readonly<{
  usageReservationId: string;
  modelCallId: string;
  reservedTokens: bigint;
  matchedPolicyIds?: readonly string[];
  policyRevision?: string;
  ruleMetadata?: Readonly<Record<string, string | number | boolean | null>>;
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

      const matchedPolicyIds = applicable.map((p) => p.id);
      const policyRevision =
        applicable.map((p) => String(p.revision ?? 1)).join(",") ||
        (price ? String(price.revision) : "1");
      const combinedRuleMetadata = applicable.reduce(
        (acc, p) => {
          if (p.ruleMetadata) Object.assign(acc, p.ruleMetadata);
          return acc;
        },
        {} as Record<string, string | number | boolean | null>,
      );

      const reservation: UsageReservation = {
        usageReservationId: randomUUID(),
        modelCallId: input.modelCallId,
        reservedTokens: input.estimatedTokens,
        matchedPolicyIds,
        policyRevision,
        ruleMetadata: combinedRuleMetadata,
      };
      this.database
        .prepare(
          "INSERT INTO usage_reservations (usage_reservation_id, model_call_id, agent_id, session_id, run_id, attempt_id, provider_id, model_id, window_start, reserved_tokens, reserved_cost_micros, status, created_at, matched_policy_ids, policy_revision, rule_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)",
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
          JSON.stringify(matchedPolicyIds),
          policyRevision,
          JSON.stringify(combinedRuleMetadata),
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
          "SELECT provider_id, model_id, created_at, matched_policy_ids, policy_revision, rule_metadata FROM usage_reservations WHERE usage_reservation_id = ?",
        )
        .get(reservation.usageReservationId) as
        | {
            provider_id: "gemini-developer";
            model_id: "gemini-3.5-flash";
            created_at: string;
            matched_policy_ids: string | null;
            policy_revision: string | null;
            rule_metadata: string | null;
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
          "INSERT INTO usage_records (usage_record_id, usage_reservation_id, outcome, provider_total_tokens, input_tokens, output_tokens, cost_micros, cost_measurement, price_revision, occurred_at, matched_policy_ids, policy_revision, rule_metadata) VALUES (?, ?, 'settled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          reservation.usageReservationId,
          usage.providerTotalTokens?.toString() ?? null,
          usage.inputTokens?.toString() ?? null,
          usage.outputTokens?.toString() ?? null,
          cost?.toString() ?? null,
          cost === undefined ? "unknown" : "derived",
          price?.revision ?? route?.policy_revision ?? null,
          occurredAt,
          route?.matched_policy_ids ??
            (reservation.matchedPolicyIds
              ? JSON.stringify(reservation.matchedPolicyIds)
              : null),
          price?.revision ??
            route?.policy_revision ??
            reservation.policyRevision ??
            null,
          route?.rule_metadata ??
            (reservation.ruleMetadata
              ? JSON.stringify(reservation.ruleMetadata)
              : null),
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

  async getUsageForRun(runId: string): Promise<{
    reservations: ReadonlyArray<Record<string, unknown>>;
    records: ReadonlyArray<Record<string, unknown>>;
  }> {
    const reservations = this.database
      .prepare(
        "SELECT usage_reservation_id, model_call_id, agent_id, session_id, run_id, attempt_id, provider_id, model_id, window_start, reserved_tokens, reserved_cost_micros, status, created_at, dispatched_at, settled_at, matched_policy_ids, policy_revision, rule_metadata FROM usage_reservations WHERE run_id = ?",
      )
      .all(runId) as Array<Record<string, unknown>>;

    const reservationIds = reservations.map(
      (r) => r.usage_reservation_id as string,
    );
    let records: Array<Record<string, unknown>> = [];
    if (reservationIds.length > 0) {
      const placeholders = reservationIds.map(() => "?").join(",");
      records = this.database
        .prepare(
          `SELECT usage_record_id, usage_reservation_id, outcome, provider_total_tokens, input_tokens, output_tokens, cost_micros, cost_measurement, price_revision, occurred_at, matched_policy_ids, policy_revision, rule_metadata FROM usage_records WHERE usage_reservation_id IN (${placeholders})`,
        )
        .all(...reservationIds) as Array<Record<string, unknown>>;
    }

    return {
      reservations: reservations.map((row) => ({
        usageReservationId: row.usage_reservation_id,
        modelCallId: row.model_call_id,
        agentId: row.agent_id,
        sessionId: row.session_id,
        runId: row.run_id,
        attemptId: row.attempt_id,
        providerId: row.provider_id,
        modelId: row.model_id,
        reservedTokens: row.reserved_tokens,
        reservedCostMicros: row.reserved_cost_micros,
        status: row.status,
        createdAt: row.created_at,
        dispatchedAt: row.dispatched_at,
        settledAt: row.settled_at,
        matchedPolicyIds: row.matched_policy_ids
          ? JSON.parse(row.matched_policy_ids as string)
          : [],
        policyRevision: row.policy_revision,
        ruleMetadata: row.rule_metadata
          ? JSON.parse(row.rule_metadata as string)
          : {},
      })),
      records: records.map((row) => ({
        usageRecordId: row.usage_record_id,
        usageReservationId: row.usage_reservation_id,
        outcome: row.outcome,
        providerTotalTokens: row.provider_total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costMicros: row.cost_micros,
        costMeasurement: row.cost_measurement,
        priceRevision: row.price_revision,
        occurredAt: row.occurred_at,
        matchedPolicyIds: row.matched_policy_ids
          ? JSON.parse(row.matched_policy_ids as string)
          : [],
        policyRevision: row.policy_revision,
        ruleMetadata: row.rule_metadata
          ? JSON.parse(row.rule_metadata as string)
          : {},
      })),
    };
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
      const route = this.database
        .prepare(
          "SELECT matched_policy_ids, policy_revision, rule_metadata FROM usage_reservations WHERE usage_reservation_id = ?",
        )
        .get(reservation.usageReservationId) as
        | {
            matched_policy_ids: string | null;
            policy_revision: string | null;
            rule_metadata: string | null;
          }
        | undefined;
      this.database
        .prepare(
          "UPDATE usage_reservations SET status = ?, settled_at = ? WHERE usage_reservation_id = ?",
        )
        .run(outcome, occurredAt, reservation.usageReservationId);
      this.database
        .prepare(
          "INSERT INTO usage_records (usage_record_id, usage_reservation_id, outcome, cost_measurement, occurred_at, matched_policy_ids, policy_revision, rule_metadata) VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          reservation.usageReservationId,
          outcome,
          occurredAt,
          route?.matched_policy_ids ??
            (reservation.matchedPolicyIds
              ? JSON.stringify(reservation.matchedPolicyIds)
              : null),
          route?.policy_revision ?? reservation.policyRevision ?? null,
          route?.rule_metadata ??
            (reservation.ruleMetadata
              ? JSON.stringify(reservation.ruleMetadata)
              : null),
        );
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
