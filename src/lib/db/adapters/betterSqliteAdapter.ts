import type { SqliteAdapter, PreparedStatement, RunResult } from "./types";
import { runWithBusyRetry } from "./busyRetry";

export function createBetterSqliteAdapter(db: import("better-sqlite3").Database): SqliteAdapter {
  // R-3: retry SQLITE_BUSY only when this connection holds no transaction — inside one
  // the caller's transaction (rolled back on throw) decides whether to replay.
  const outsideTransaction = () => !db.inTransaction;

  return {
    driver: "better-sqlite3",

    get open() {
      return db.open;
    },

    get name() {
      return db.name;
    },

    get inTransaction() {
      return db.inTransaction;
    },

    prepare<Row = unknown>(sql: string): PreparedStatement<Row> {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]): RunResult =>
          runWithBusyRetry(() => stmt.run(...params) as unknown as RunResult, outsideTransaction),
        get: (...params: unknown[]) => stmt.get(...params) as Row | undefined,
        all: (...params: unknown[]) => stmt.all(...params) as Row[],
      };
    },

    exec(sql: string): void {
      runWithBusyRetry(() => db.exec(sql), outsideTransaction);
    },

    pragma(pragmaStr: string, options?: { simple?: boolean }): unknown {
      return db.pragma(pragmaStr, options);
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      // better-sqlite3 rolls the transaction back on throw, so a top-level BUSY leaves no
      // partial work behind and the whole function can be replayed.
      const tx = db.transaction(fn) as (...args: unknown[]) => T;
      return (...args: unknown[]) => runWithBusyRetry(() => tx(...args), outsideTransaction);
    },

    immediate(fn: () => void): void {
      const tx = db.transaction(fn) as unknown as { immediate: () => void };
      runWithBusyRetry(() => tx.immediate(), outsideTransaction);
    },

    async backup(destination: string): Promise<void> {
      await db.backup(destination);
    },

    checkpoint(mode = "TRUNCATE"): void {
      try {
        db.pragma(`wal_checkpoint(${mode})`);
      } catch {}
    },

    close(): void {
      db.close();
    },

    get raw() {
      return db;
    },
  };
}
