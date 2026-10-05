// Sign in with ChatGPT, for the browser. pi-ai's own flow
// (auth/oauth/openai-chatgpt.js) imports node:http for a loopback callback
// server; this is the same flow with only its fallback: the sign-in ends on
// http://127.0.0.1:1455/auth/callback, which a phone can't load, and the user
// pastes that address back. auth.openai.com and api.openai.com both allow
// cross-origin calls, so the token exchange and the model requests run here.
// ponytail: a copy of pi-ai 1.0.0's flow; drop it when pi-ai ships a browser-safe one.
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

const DYNAMIC_CLIENT_ID = "dynamic_agent_client"; // OpenAI issues a client ID per login, in the callback
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
const EXPIRY_MARGIN_MS = 3 * 60 * 1000; // refresh before a request could start on an expiring token

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const randomValue = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function pkce() {
  const verifier = randomValue();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function fromRedirect(input: string, expectedState: string) {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Paste the full address the sign-in ended on"); }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`The pasted address must start with ${REDIRECT_URI}`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`ChatGPT sign-in failed: ${error}`);
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code) throw new Error("Missing authorization code");
  if (url.searchParams.get("state") !== expectedState) throw new Error("This address is from another sign-in; start again");
  if (!clientId) throw new Error("The address has no issued client ID");
  return { code, clientId };
}

async function requestToken(body: URLSearchParams, signal?: AbortSignal) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI token request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function credential(token: Record<string, unknown>, clientId: string): OAuthCredential {
  const { access_token: access, refresh_token: refresh, scope, expires_in: expiresIn } = token;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof scope !== "string" || typeof expiresIn !== "number") {
    throw new Error("OpenAI's token response is missing fields");
  }
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) throw new Error(`The ChatGPT grant did not include ${DIRECT_TOKEN_SCOPE}`);
  return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS, clientId, scopes };
}

export const chatgptOAuth: OAuthAuth = {
  name: "OpenAI (ChatGPT subscription)",
  isSubscription: true,
  loginLabel: "Sign in with ChatGPT",
  async login(interaction, options) {
    const deviceId = options?.getDeviceId?.();
    if (!deviceId) throw new Error("Sign in with ChatGPT needs a device ID");
    const { verifier, challenge } = await pkce();
    const state = randomValue();
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: DYNAMIC_CLIENT_ID,
      agent_name_hint: "Pi",
      ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      nonce: randomValue(),
    }).toString();
    interaction.notify({ type: "auth_url", url: url.href, instructions: "Sign in, then paste the address the page ends on." });
    const pasted = await interaction.prompt({ type: "manual_code", message: "Paste the address the sign-in ended on", placeholder: REDIRECT_URI, signal: interaction.signal });
    const { code, clientId } = fromRedirect(pasted, state);
    const token = await requestToken(new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE,
    }), interaction.signal);
    return credential(token, clientId);
  },
  async refresh(stored, signal) {
    const clientId = stored.clientId;
    if (typeof clientId !== "string" || !clientId) throw new Error("This ChatGPT sign-in has no client ID; sign in again");
    const token = await requestToken(new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId, refresh_token: stored.refresh, resource: RESOURCE,
    }), signal);
    return credential(token, clientId);
  },
  async toAuth(stored) {
    return { apiKey: stored.access };
  },
};
