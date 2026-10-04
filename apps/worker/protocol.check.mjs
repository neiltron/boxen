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
console.log(`protocol.check ok (${defined.join(", ")})`);
