import { useEffect, useState } from "react";
import { WS_BASE, type SessionMeta } from "@/lib/api";

// Live session list from the Directory cell.
export function useDirectory(): SessionMeta[] {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const heartbeat = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 25_000);

    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/api/directory/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: "sub" }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "sessions") setSessions(m.sessions);
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      ws?.close();
    };
  }, []);

  return sessions;
}
