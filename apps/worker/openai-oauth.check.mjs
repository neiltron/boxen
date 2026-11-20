// Exercise the actual pi-ai ChatGPT flow with celld's node:http limitation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

let listenerAttempts = 0;
http.createServer = () => {
  listenerAttempts++;
  throw new Error("node:http.createServer is not implemented in celld");
};
syncBuiltinESMExports();
registerBunOAuthFlows();

const models = builtinModels();
const deviceId = crypto.randomUUID();
const redirect = "http://127.0.0.1:1455/auth/callback";
let exchanges = 0;
let authorizationUrl;
globalThis.fetch = async (url, { body }) => {
  exchanges++;
  assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.equal(body.get("code"), "test-code");
  assert.equal(body.get("client_id"), "issued-client");
  assert.equal(body.get("redirect_uri"), redirect);
  assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
    authorizationUrl.searchParams.get("code_challenge"));
  return Response.json({ access_token: "test-access", refresh_token: "test-refresh", id_token: "test-id",
    expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
};

function login(stateFor = (state) => state) {
  return models.login("openai", "oauth", {
    notify(event) {
      if (event.type === "auth_url") authorizationUrl = new URL(event.url);
    },
    async prompt({ type }) {
      assert.equal(type, "manual_code");
      assert.equal(authorizationUrl.origin, "https://auth.openai.com");
      assert.equal(authorizationUrl.searchParams.get("ext_agent_host_id"), `urn:uuid:${deviceId}`);
      assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirect);
      const state = stateFor(authorizationUrl.searchParams.get("state"));
      return `${redirect}?${new URLSearchParams({ code: "test-code", state, client_id: "issued-client" })}`;
    },
  }, { getDeviceId: () => deviceId, openaiCallbackServer: false });
}

await assert.rejects(login(() => "wrong-state"), /OAuth state mismatch/);
assert.equal(exchanges, 0);
const credential = await login();
assert.equal(credential.clientId, "issued-client");
assert.equal(credential.access, "test-access");
assert.equal(exchanges, 1);
assert.equal(listenerAttempts, 0);
console.log("ChatGPT OAuth works without an HTTP server and preserves state and PKCE checks");
