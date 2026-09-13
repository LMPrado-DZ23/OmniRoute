export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement. `Row` is the shape the caller declares for the selected columns,
 * for example db.prepare<{ id: string }>(sql). It defaults to `unknown`, so callers that pass
 * no type argument keep reading untyped rows. Drivers return plain objects; each adapter's
 * `prepare` is the single place where those rows take the declared shape.
 */
export interface PreparedStatement<Row = unknown> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

export interface SqliteAdapter {
  readonly driver: "better-sqlite3" | "node:sqlite" | "bun:sqlite" | "sql.js";
  readonly open: boolean;
  readonly name: string;
  /** Driver transaction state when exposed by the underlying SQLite implementation. */
  readonly inTransaction?: boolean;

  prepare<Row = unknown>(sql: string): PreparedStatement<Row>;
  exec(sql: string): void;
  pragma(pragmaStr: string, options?: { simple?: boolean }): unknown;

  /** Retorna uma função que quando chamada executa fn em uma transação DEFERRED */
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;

  /** Executa fn em uma transação IMMEDIATE (adquire write lock imediatamente) */
  immediate(fn: () => void): void;

  /** Backup nativo ou file-copy fallback */
  backup(destination: string): Promise<void>;

  checkpoint(mode?: string): void;
  close(): void;

  readonly raw: unknown;
}
