// pi-durable's portable SQLite facade over SQLite's own WebAssembly build,
// whose oo1 API is synchronous. As apps/worker/src/cell-sqlite.js does for a
// cell: one queue serializes everything, and a transaction holds the queue
// until it commits or rolls back.
import type { Database } from "@sqlite.org/sqlite-wasm";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

export class WasmSqlite implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private db: Database;
  constructor(db: Database) { this.db = db; }

  private queue<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }

  private rows(sql: string, params: SqliteValue[]) {
    return this.db.exec({ sql, bind: params.length ? params : undefined, rowMode: "object", returnValue: "resultRows" });
  }

  private executor(live: () => boolean): SqliteExecutor {
    const check = () => { if (!live()) throw new Error("transaction handle is no longer active"); };
    return {
      exec: async (sql) => { check(); this.db.exec(sql); },
      run: async (sql, ...p) => { check(); this.rows(sql, p); },
      get: async <T extends object>(sql: string, ...p: SqliteValue[]) => { check(); return this.rows(sql, p)[0] as T | undefined; },
      all: async <T extends object>(sql: string, ...p: SqliteValue[]) => { check(); return this.rows(sql, p) as T[]; },
    };
  }

  private direct = this.executor(() => true);
  exec(sql: string) { return this.queue(() => this.direct.exec(sql)); }
  run(sql: string, ...p: SqliteValue[]) { return this.queue(() => this.direct.run(sql, ...p)); }
  get<T extends object>(sql: string, ...p: SqliteValue[]) { return this.queue(() => this.direct.get<T>(sql, ...p)); }
  all<T extends object>(sql: string, ...p: SqliteValue[]) { return this.queue(() => this.direct.all<T>(sql, ...p)); }

  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      let live = true;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback(this.executor(() => live));
        live = false;
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        live = false;
        try { this.db.exec("ROLLBACK"); } catch (r) { throw new AggregateError([e, r], "rollback failed"); }
        throw e;
      }
    });
  }

  close() { return this.queue(() => this.db.close()); }
}
