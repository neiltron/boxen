// Default: same-origin, proxied by the vite dev server to the celld node.
// Set VITE_API_BASE to talk to a node directly (e.g. a built/static deploy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";
export const WS_BASE = API_BASE
  ? API_BASE.replace(/^http/, "ws")
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

export interface SessionMeta {
  id: string;
  name: string;
  archivedAt?: number | null;
  metadataRevision?: number;
  cwd: string;
  repo?: string;
  branch?: string;
  status?: string;
  createdAt: number;
  lastActivity?: number;
}

// Named after the repo (or "untitled") until the first message titles it.
export async function createSession(input: { name?: string; repo?: string; branch?: string }): Promise<SessionMeta> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
}

export interface AuthStatus {
  providers: string[];
  agent: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
}

async function post<T>(path: string, body: object, method = "POST"): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data;
}

// Sign-in runs in the Directory cell: open `url`, then paste the redirect back.
type LoginStep = { url?: string; code?: string; done?: boolean; error?: string };

// The response stays open for the whole sign-in (see Directory.loginStream):
// resolves with the first step, then reports the outcome through `onEnd`.
export async function startLogin(provider: string, onEnd: (end: LoginStep) => void): Promise<LoginStep> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok || !res.body) throw new Error(`sign-in failed: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
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
}
export const finishLogin = (redirectUrl: string) => post<AuthStatus>("/api/auth/finish", { redirectUrl });
export const logout = (provider: string) => post<AuthStatus>("/api/auth/logout", { provider });

export interface ArtifactSummary {
  id: string;
  session: string;
  title: string;
  kind: "markdown" | "html" | "svg" | "mermaid" | "code";
  language?: string | null;
  version: number;
  updatedAt: number;
  snippet?: string;
}

export interface Artifact extends ArtifactSummary {
  content: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data;
}

export const listArtifacts = (session: string) => get<ArtifactSummary[]>(`/api/artifacts?session=${session}`);
export const searchArtifacts = (q: string) => get<ArtifactSummary[]>(`/api/artifacts?q=${encodeURIComponent(q)}`);
export const getArtifact = (id: string, version?: number) =>
  get<Artifact>(`/api/artifacts/${id}${version ? `?v=${version}` : ""}`);

export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: { name: string } | null;
  oauth: { name: string; label: string } | null;
  connected: "api_key" | "oauth" | null;
}

export const listProviders = () => get<ProviderInfo[]>("/api/providers");
export const setApiKey = (provider: string, key: string) => post<AuthStatus>(`/api/providers/${provider}/key`, { key });

export type SecretKey = "GH_TOKEN" | "LINEAR_API_KEY";
export const listSecrets = () => get<{ keys: SecretKey[] }>("/api/secrets");
export const setSecret = (key: SecretKey, value: string) => post<{ keys: SecretKey[] }>("/api/secrets", { [key]: value });

// GitHub lookups for the create form (Directory cell, the fleet's GitHub token).
export interface Repo {
  fullName: string;
  cloneUrl: string;
  pushedAt: string;
  defaultBranch: string;
  private: boolean;
}

export const fetchRepos = () => get<Repo[]>("/api/github/repos");
export const fetchBranches = (fullName: string) =>
  get<{ defaultBranch: string; branches: string[] }>(`/api/github/branches?repo=${encodeURIComponent(fullName)}`);

// owner/name for a GitHub URL (https, ssh, or git@), else null.
export function githubRepo(url: string): string | null {
  const m = url.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The session's working tree against HEAD, untracked files included.
export const fetchDiff = (sessionId: string) => get<{ repo: boolean; patch: string }>(`/api/session/${sessionId}/diff`);
export const fetchListeningPorts = (sessionId: string) => get<{ ports: number[] }>(`/api/session/${sessionId}/ports`);

export const updateSession = (id: string, patch: { name?: string; archived?: boolean }) =>
  post<SessionMeta>(`/api/session/${id}`, patch, "PATCH");
