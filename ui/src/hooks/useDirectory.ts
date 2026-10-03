import { useEffect, useState } from "react";
import { WS_BASE, type AuthStatus, type SessionMeta } from "@/lib/api";
import { liveSocket } from "@/lib/live-socket";

// Live session list and sign-in status from the Directory cell. Retain the
// last list while reconnecting; an empty/loading directory isn't a deletion.
export function useDirectory(): { sessions: SessionMeta[]; auth: AuthStatus | null } {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    const connection = liveSocket(`${WS_BASE}/api/directory/ws`, {
      open: () => { connection.send({ type: "sub" }); },
      message(e) {
        const m = JSON.parse(e.data);
        if (m.type === "sessions") { setSessions(m.sessions); setAuth(m.auth ?? null); }
      },
    });
    return () => connection.close();
  }, []);

  return { sessions, auth };
}
