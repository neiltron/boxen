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
