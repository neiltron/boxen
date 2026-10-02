// Default: same-origin, proxied by the vite dev server to the celld node.
// Set VITE_API_BASE to talk to a node directly (e.g. a built/static deploy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";
export const WS_BASE = API_BASE
  ? API_BASE.replace(/^http/, "ws")
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  status?: string;
  createdAt: number;
  lastActivity?: number;
}

export async function createSession(name: string): Promise<SessionMeta> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
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

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data;
}

// Sign-in runs in the Directory cell: open `url`, then paste the redirect back.
export const startLogin = (provider: string) => post<{ url?: string; code?: string; done?: boolean }>("/api/auth/login", { provider });
export const finishLogin = (redirectUrl: string) => post<AuthStatus>("/api/auth/finish", { redirectUrl });
export const logout = (provider: string) => post<AuthStatus>("/api/auth/logout", { provider });
