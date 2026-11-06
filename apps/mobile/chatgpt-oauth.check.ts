// The pasted end of a ChatGPT sign-in, in every shape a phone copies it.
// Run: node chatgpt-oauth.check.ts
import assert from "node:assert/strict";
import { fromRedirect } from "./src/chatgpt-oauth.ts";

const query = "code=abc&scope=x&state=s1&client_id=client_9";
const expected = { code: "abc", clientId: "client_9" };
for (const pasted of [
  `http://127.0.0.1:1455/auth/callback?${query}`,
  `127.0.0.1:1455/auth/callback?${query}`, // copied without the scheme
  `  ${query}\n`, // only the query, with whitespace
  `http://127.0.0.1:1455/auth/callback?${query}#`,
]) assert.deepEqual(fromRedirect(pasted, "s1"), expected, pasted);

// Copied short (Safari shows a failed page as its host): says what arrived.
assert.throws(() => fromRedirect("127.0.0.1", "s1"), /isn't the whole address.*Pasted: "127\.0\.0\.1"/);
assert.throws(() => fromRedirect("http://127.0.0.1:1455/auth/callback?code=abc&state=s1", "s1"), /needs its code, state and client_id/);
assert.throws(() => fromRedirect(`http://127.0.0.1:1455/auth/callback?${query}`, "s2"), /another sign-in/);
assert.throws(() => fromRedirect("http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User+cancelled", "s1"),
  /sign-in failed: User cancelled/);
console.log("chatgpt-oauth.check: ok");
