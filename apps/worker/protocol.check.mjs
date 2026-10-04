// node --experimental-vm-modules protocol.check.mjs
// The Session cell's WebSocket commands against the protocol the session
// client speaks (@pi-durable-sessions/client's protocol.ts): the cell's
// handler table and SESSION_COMMANDS must name the same commands, so neither
// side gains or loses one silently.
import assert from "node:assert/strict";
import { SESSION_COMMANDS } from "@pi-durable-sessions/client";
import { load } from "./check-harness.mjs";

const { Session } = await load({ "@cloudflare/sandbox": { getSandbox() {} } });
const handled = Object.keys(Session.commands).sort();
const defined = [...SESSION_COMMANDS].sort();
assert.deepEqual(handled, defined,
  `the cell handles [${handled}] but the protocol defines [${defined}]: ` +
  "change apps/worker/src/session.js and packages/client/src/protocol.ts together");

// A prompt the cell refuses names its requestId in the error frame; an
// error after the prompt was admitted (here the automatic title) does not.
const quiet = console.error;
console.error = () => {};
const errors = async (open) => {
  const cell = new Session({ id: "s" }, {});
  cell.open = open;
  cell.reopen = () => {}; // a poisoned Harness; not under test
  cell.meta = async () => ({ titled: false });
  cell.autoTitle = async () => { throw new Error("title failed"); };
  const sent = [];
  await cell.webSocketMessage({ send: (m) => sent.push(JSON.parse(m)) }, JSON.stringify({ type: "prompt", message: "hi", requestId: "r1" }));
  return sent;
};
assert.deepEqual(await errors(async () => { throw new Error("no harness"); }), [{ type: "error", error: "no harness", requestId: "r1" }]);
const root = (submit) => async () => ({ root: { submit }, models: {} });
assert.deepEqual(await errors(root(async () => { throw new Error("Session is poisoned"); })),
  [{ type: "error", error: "Session is poisoned", requestId: "r1" }]);
assert.deepEqual(await errors(root(async () => {})), [{ type: "error", error: "title failed" }]);
console.error = quiet;
console.log(`protocol.check ok (${defined.join(", ")}; prompt refusals name their requestId)`);
