import type { AppDatabase } from "../database.js";

export type Migration = {
  version: number;
  name: string;
  up(database: AppDatabase): void;
};
