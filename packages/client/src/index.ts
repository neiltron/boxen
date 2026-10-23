// The typed client for the worker's REST API. Request and response types come
// from openapi.json through src/openapi.ts (pnpm run generate); nothing here
// restates them. Runs wherever fetch does: the browser and Node. The Session
// WebSocket, which OpenAPI does not describe, is protocol.ts and the session
// client.
import createClient from "openapi-fetch";
import spec from "../openapi.json" with { type: "json" };
import type { components, paths } from "./openapi.ts";
import { sessionClient, sessionSocketUrl } from "./session-client.ts";
import type { Transport } from "./socket.ts";

export * from "./protocol.ts";
export * from "./session-client.ts";
export { reconnecting, type Clock, type SocketDeps, type Transport, type Wire } from "./socket.ts";
export { webSocketTransport } from "./websocket.ts";

type Schemas = components["schemas"];
export type Session = Schemas["Session"];
export type CreateSession = Schemas["CreateSession"];
export type SessionPatch = Schemas["SessionPatch"];
export type ProviderInfo = Schemas["ProviderInfo"];
export type AuthStatus = Schemas["AuthStatus"];
export type LoginStep = Schemas["LoginStep"];
export type ArtifactKind = Schemas["ArtifactKind"];
export type ArtifactSummary = Schemas["ArtifactSummary"];
export type Artifact = Schemas["Artifact"];
export type Repo = Schemas["Repo"];
export type SandboxToken = Schemas["SandboxToken"];

// Constants the contract defines, for code that needs them at runtime.
export const SANDBOX_TOKENS = spec.components.schemas.SandboxToken.enum as SandboxToken[];
export const ARTIFACT_KINDS = spec.components.schemas.ArtifactKind.enum as ArtifactKind[];
const port = spec.components.schemas.PreviewPort;
export const PREVIEW_PORTS = { min: port.minimum, max: port.maximum, reserved: port.not.const };
export const validPreviewPort = (n: number) =>
  Number.isInteger(n) && n >= PREVIEW_PORTS.min && n <= PREVIEW_PORTS.max && n !== PREVIEW_PORTS.reserved;

// The API at `baseUrl` ("" for same-origin). `fetch` replaces the global one,
// e.g. to call a worker in-process.
export function apiClient(baseUrl: string, fetch?: (request: Request) => Promise<Response>) {
  const api = createClient<paths>({ baseUrl, fetch });
  const session = (id: string) => ({ params: { path: { id } } });
  return {
    listSessions: async () => ok(await api.GET("/api/sessions")),
    createSession: async (body: CreateSession) => ok(await api.POST("/api/sessions", { body })),
    updateSession: async (id: string, body: SessionPatch) => ok(await api.PATCH("/api/session/{id}", { ...session(id), body })),
    getDiff: async (id: string) => ok(await api.GET("/api/session/{id}/diff", session(id))),
    listPorts: async (id: string) => ok(await api.GET("/api/session/{id}/ports", session(id))),

    listProviders: async () => ok(await api.GET("/api/providers")),
    setApiKey: async (provider: string, key: string) =>
      ok(await api.POST("/api/providers/{provider}/key", { params: { path: { provider } }, body: { key } })),
    // The response stays open for the whole sign-in (see openapi.json):
    // resolves with the first step, then reports the outcome through `onEnd`.
    startLogin: async (provider: string, onEnd: (end: LoginStep) => void): Promise<LoginStep> => {
      const { data, response } = await api.POST("/api/auth/login", { body: { provider }, parseAs: "stream" });
      if (!response.ok || !data) throw new Error(`sign-in failed: ${response.status}`);
      const reader = data.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      const next = async (): Promise<LoginStep> => {
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            const msg = JSON.parse(buf.slice(0, nl)) as LoginStep;
            buf = buf.slice(nl + 1);
            if (Object.keys(msg).length) return msg; // {} lines are keepalives
            continue;
          }
          const { value, done } = await reader.read();
          if (done) return { error: "sign-in ended without an answer" };
          buf += value;
        }
      };
      const first = await next();
      if (first.url) void next().then(onEnd);
      return first;
    },
    finishLogin: async (redirectUrl: string) => ok(await api.POST("/api/auth/finish", { body: { redirectUrl } })),
    logout: async (provider: string) => ok(await api.POST("/api/auth/logout", { body: { provider } })),
    // The provider's redirect, as the web app's dev server forwards it: the
    // page for the browser tab, or the worker's { error } as JSON.
    authCallback: async (redirectUrl: string) => {
      const { data, error, response } = await api.GET("/api/auth/callback", { params: { query: { u: redirectUrl } }, parseAs: "text" });
      const body = data ?? (typeof error === "string" ? error : JSON.stringify(error));
      return { status: response.status, contentType: response.headers.get("content-type"), body };
    },

    listArtifacts: async (query: { session?: string; q?: string }) => ok(await api.GET("/api/artifacts", { params: { query } })),
    getArtifact: async (artifactId: string, version?: number) =>
      ok(await api.GET("/api/artifacts/{artifactId}", { params: { path: { artifactId }, query: { v: version || undefined } } })),

    listRepos: async () => ok(await api.GET("/api/github/repos")),
    listBranches: async (repo: string) => ok(await api.GET("/api/github/branches", { params: { query: { repo } } })),
    listSandboxTokens: async () => ok(await api.GET("/api/secrets")),
    setSandboxTokens: async (body: Partial<Record<SandboxToken, string>>) => ok(await api.POST("/api/secrets", { body })),
  };
}

// Where callers outside the web app (boxen, the MCP server) find the system when
// neither a flag nor $BOXEN_URL says otherwise.
export const DEFAULT_URL = "http://127.0.0.1:8093";

// The system at `baseUrl`, for those callers: its REST API and a session
// client per Session. The one place they make requests, so auth, when it
// comes, attaches here and nowhere else: a credential on `fetch` for REST,
// and on the socket URL or transport for the Session WebSocket.
export function system(baseUrl: string, deps: { fetch?: (request: Request) => Promise<Response>; transport: Transport }) {
  return {
    api: apiClient(baseUrl, deps.fetch),
    session: (id: string) => sessionClient(sessionSocketUrl(baseUrl, id), { transport: deps.transport }),
  };
}

// The data, or the worker's { error } as a thrown Error.
function ok<T>({ data, error, response }: { data?: T; error?: unknown; response: Response }): T {
  if (error !== undefined || data === undefined) {
    const message = (error as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === "string" ? message : `${response.url}: ${response.status}`);
  }
  return data;
}
