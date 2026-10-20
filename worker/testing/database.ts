import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";

type BindValue = SQLInputValue;

class TestPreparedStatement {
  private values: BindValue[] = [];

  constructor(private readonly sqlite: DatabaseSync, private readonly query: string) {}

  bind(...values: unknown[]): this {
    this.values = values as BindValue[];
    return this;
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.statement().get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (columnName === undefined ? row : row[columnName]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.statement().all(...this.values) as T[];
    return result(results, 0);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const before = this.sqlite.prepare("SELECT total_changes() AS count").get()?.count as number;
    const results = this.statement().all(...this.values) as T[];
    const metadata = this.sqlite.prepare("SELECT total_changes() - ? AS changes, last_insert_rowid() AS last_row_id").get(before) as {
      changes: number;
      last_row_id: number;
    };
    return result(results, Number(metadata.changes), Number(metadata.last_row_id));
  }

  private statement(): StatementSync {
    return this.sqlite.prepare(this.query);
  }
}

function result<T>(results: T[], changes: number, lastRowId?: number): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      changes,
      ...(lastRowId === undefined ? {} : { last_row_id: lastRowId }),
    } as D1Result<T>["meta"],
  };
}

/** Creates an isolated SQLite database with the same schema as the D1 migrations. */
export function createTestDatabase(): { db: D1Database; sqlite: DatabaseSync; close(): void } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const migrations = readdirSync(migrationsPath)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  for (const migration of migrations) {
    sqlite.exec(readFileSync(resolve(migrationsPath, migration), "utf8"));
  }

  const db = {
    prepare(query: string): D1PreparedStatement {
      return new TestPreparedStatement(sqlite, query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          results.push(await (statement as unknown as TestPreparedStatement).run<T>());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  return { db, sqlite, close: () => sqlite.close() };
}
