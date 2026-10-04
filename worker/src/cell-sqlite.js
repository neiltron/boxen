// pi-durable's portable SQLite facade over a cell's synchronous storage.sql.
// One queue serializes everything; a durable transaction runs inside
// storage.transaction, so it commits (or rolls back) with the cell's own write.
export class CellSqlite {
  constructor(storage) {
    this.storage = storage;
    this.tail = Promise.resolve();
  }

  queue(fn) {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }

  exec(sql) { return this.queue(() => { this.storage.sql.exec(sql); }); }
  run(sql, ...p) { return this.queue(() => { this.storage.sql.exec(sql, ...p).toArray(); }); }
  get(sql, ...p) { return this.queue(() => this.storage.sql.exec(sql, ...p).toArray()[0]); }
  all(sql, ...p) { return this.queue(() => this.storage.sql.exec(sql, ...p).toArray()); }

  transaction(cb) {
    return this.queue(() => this.storage.transaction(() => {
      let live = true;
      const op = (fn) => async (sql, ...p) => {
        if (!live) throw new Error("transaction handle is no longer active");
        return fn(this.storage.sql.exec(sql, ...p));
      };
      const tx = {
        exec: async (sql) => { if (!live) throw new Error("transaction handle is no longer active"); this.storage.sql.exec(sql); },
        run: op((c) => { c.toArray(); }),
        get: op((c) => c.toArray()[0]),
        all: op((c) => c.toArray()),
      };
      return cb(tx).finally(() => { live = false; });
    }));
  }

  async close() {}
}
