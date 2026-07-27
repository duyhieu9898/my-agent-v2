import Database from "better-sqlite3";

export type AppDatabase = Database.Database;

export type DatabaseOptions = {
  busyTimeoutMs?: number;
};

export function openDatabase(
  path: string,
  options: DatabaseOptions = {},
): AppDatabase {
  const database = new Database(path);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);

  return database;
}
