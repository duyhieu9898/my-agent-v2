import type { AppDatabase } from "./database.js";
import { migrations } from "./migrations/index.js";
import type { Migration } from "./migrations/types.js";

type AppliedMigrationRow = {
  version: number;
};

export function migrateDatabase(
  database: AppDatabase,
  migrationList: readonly Migration[] = migrations,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .prepare(
      `
      SELECT version
      FROM schema_migrations
      ORDER BY version ASC
    `,
    )
    .all() as AppliedMigrationRow[];

  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (
      version,
      name,
      applied_at
    )
    VALUES (?, ?, ?)
  `);

  const applyMigration = database.transaction((migration: Migration) => {
    migration.up(database);

    insertMigration.run(
      migration.version,
      migration.name,
      new Date().toISOString(),
    );
  });

  for (const migration of migrationList) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    applyMigration(migration);
  }
}
