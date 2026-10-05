import { useEffect, useState } from "react";
import { webSocketTransport, reconnecting } from "@pi-durable-sessions/client";
import { WS_BASE, type AuthStatus, type SessionMeta } from "@/lib/api";

type Frame = { type: "sessions"; sessions: SessionMeta[]; auth?: AuthStatus };

// Live session list and sign-in status from the Directory cell. The last list
// stays while the socket rejoins.
export function useDirectory(): { sessions: SessionMeta[]; auth: AuthStatus | null } {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    const socket = reconnecting<Frame>(`${WS_BASE}/api/directory/ws`, {
      message(m) {
        if (m.type === "sessions") { setSessions(m.sessions); setAuth(m.auth ?? null); }
      },
    }, { transport: webSocketTransport });
    return () => socket.close();
  }, []);

  return { sessions, auth };
}
