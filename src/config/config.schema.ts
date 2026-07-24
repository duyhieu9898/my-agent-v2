import { z } from "zod";

export const configSchema = z.object({
  nodeEnv: z
    .enum(["development", "test", "production"])
    .default("development"),

  logLevel: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),

  dataDir: z.string().default("./data"),
  workspaceDir: z.string().default("./workspace"),

  gateway: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65_535).default(3210),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;