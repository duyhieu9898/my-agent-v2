import Database from "better-sqlite3";

export type AppDatabase = Database.Database;

export function openDatabase(path: string): AppDatabase {
  const database = new Database(path);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  return database;
}
