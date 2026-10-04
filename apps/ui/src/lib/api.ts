import { apiClient, type SandboxToken, type Session } from "@pi-durable-sessions/client";
export type { Artifact, ArtifactSummary, AuthStatus, ModelInfo, ProviderInfo, Repo, SandboxToken } from "@pi-durable-sessions/client";
export { PREVIEW_PORTS, SANDBOX_TOKENS, validPreviewPort } from "@pi-durable-sessions/client";

// Default: same-origin, proxied by the vite dev server to the celld node.
// Set VITE_API_BASE to talk to a node directly (e.g. a built/static deploy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";
export const WS_BASE = API_BASE
  ? API_BASE.replace(/^http/, "ws")
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// Every endpoint and its types come from the shared client's OpenAPI spec.
export type SessionMeta = Session;
const api = apiClient(API_BASE);

// Named after the repo (or "untitled") until the first message titles it.
export const createSession = api.createSession;

export const finishLogin = api.finishLogin;
export const logout = api.logout;
// Sign-in runs in the Directory cell: open `url`, then paste the redirect back.
export const startLogin = api.startLogin;

export const listArtifacts = (session: string) => api.listArtifacts({ session });
export const searchArtifacts = (q: string) => api.listArtifacts({ q });
export const getArtifact = api.getArtifact;

export const listProviders = api.listProviders;
export const setApiKey = api.setApiKey;

export const listSecrets = api.listSandboxTokens;
export const setSecret = (key: SandboxToken, value: string) => api.setSandboxTokens({ [key]: value });

// GitHub lookups for the create form (Directory cell, the fleet's GitHub token).
export const fetchRepos = api.listRepos;
export const fetchBranches = api.listBranches;

// owner/name for a GitHub URL (https, ssh, or git@), else null.
export function githubRepo(url: string): string | null {
  const m = url.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The session's working tree against HEAD, untracked files included.
export const fetchDiff = api.getDiff;
export const fetchListeningPorts = api.listPorts;

export const updateSession = api.updateSession;
