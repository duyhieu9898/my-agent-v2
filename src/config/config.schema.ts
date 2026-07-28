import { z } from "zod";

const usagePriceSchema = z.object({
  revision: z.string().min(1),
  providerId: z.literal("gemini-developer"),
  modelId: z.literal("gemini-3.5-flash"),
  effectiveFrom: z.string().datetime(),
  inputMicrosPerMillionTokens: z.coerce.bigint().nonnegative(),
  outputMicrosPerMillionTokens: z.coerce.bigint().nonnegative(),
});

const usageCapPolicySchema = z.object({
  id: z.string().min(1),
  revision: z.coerce.number().int().positive(),
  agentId: z.string().min(1).optional(),
  providerId: z.literal("gemini-developer").optional(),
  modelId: z.literal("gemini-3.5-flash").optional(),
  window: z.enum(["day", "month"]),
  maxTokens: z.coerce.bigint().positive().optional(),
  maxCostMicros: z.coerce.bigint().positive().optional(),
  enabled: z.coerce.boolean().default(true),
});

export const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),

  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  dataDir: z.string().default("./data"),
  workspaceDir: z.string().default("./workspace"),

  database: z.object({
    path: z.string().min(1),
  }),

  gateway: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65_535).default(3210),
  }),

  runtime: z.object({
    perSessionQueueCapacity: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(16),
    maxConcurrentModelCalls: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(4),
    runTimeoutMs: z.coerce.number().int().min(1).max(3_600_000).default(60_000),
  }),

  agent: z.object({
    defaultId: z.literal("primary").default("primary"),
    model: z.object({
      providerId: z.literal("gemini-developer"),
      modelId: z.literal("gemini-3.5-flash"),
      geminiApiKeyEnvironmentVariable: z
        .string()
        .min(1)
        .default("GEMINI_API_KEY"),
      contextTokenBudget: z.coerce.number().int().positive().default(12000),
    }),
  }),

  usage: z.object({
    captureProfile: z
      .enum(["production", "verification", "development"])
      .default("production"),
    maxOutputTokens: z.coerce.number().int().positive().default(8_192),
    thinkingTokens: z.coerce.number().int().nonnegative().default(0),
    reservationSafetyMarginTokens: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(256),
    priceCatalog: z.array(usagePriceSchema).default([]),
    capPolicies: z.array(usageCapPolicySchema).default([]),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
