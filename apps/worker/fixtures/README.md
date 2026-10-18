# pi-durable 1.0.0 fixture

`pi-durable-1.0.json` is a SQL schema and row dump from the published 1.0.0 Harness and Node SQLite backend. It contains one completed tool turn, a display-only note, a running replay-safe tool, and queued input. It has no credentials or user data.

`generate-1.0.mjs` documents regeneration with an isolated exact 1.0.0 install. Do not regenerate it using the current runtime. The dump is captured before graceful close, while the tool waits, to model a process loss. Timestamps and generated provider IDs can change on regeneration.

CI restores a copy into SQLite and opens it with 1.3.0 through the application's `CellSqlite` facade. It checks history, v1-to-v2 pending-task migration, queued input, request deduplication, and a second reopen. This does not certify host upgrades, unsafe tool replay, or downgrade.
