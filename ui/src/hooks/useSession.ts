import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE, type ModelInfo, type SessionMeta } from "@/lib/api";
import { applyEvent, emptyModel, type ChatModel } from "@/lib/events";

// One WebSocket to the Session cell: a snapshot of the conversation, then
// live agent events. Events mutate a ref'd model; a version counter drives renders
// (event bursts during streaming would thrash immutable state).
export function useSession(id: string | null) {
  const modelRef = useRef<ChatModel>(emptyModel());
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    modelRef.current = emptyModel();
    setMeta(null);
    setReady(false);
    setVersion((v) => v + 1);
    if (!id) return;

    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const heartbeat = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 25_000);

    const connect = () => {
      modelRef.current = emptyModel();
      const ws = new WebSocket(`${WS_BASE}/api/session/${id}/ws`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "sub" }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "events") {
          for (const ev of m.events) applyEvent(modelRef.current, ev);
          setVersion((v) => v + 1);
        } else if (m.type === "error") {
          applyEvent(modelRef.current, m);
          setVersion((v) => v + 1);
        } else if (m.type === "models") {
          setModels(m.models);
        } else if (m.type === "meta") {
          // A subscription snapshot can race a mutation broadcast while the
          // server opens the Harness. Never replace newer metadata with it.
          setMeta((current) => (current?.metadataRevision ?? 0) > (m.meta.metadataRevision ?? 0) ? current : m.meta);
        } else if (m.type === "ready") {
          setReady(true);
          setVersion((v) => v + 1);
        }
      };
      // Also how the server hands over a reopened session: reconnect and
      // take its fresh snapshot.
      ws.onclose = () => {
        setReady(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [id]);

  const send = useCallback((cmd: object) => {
    wsRef.current?.send(JSON.stringify(cmd));
  }, []);

  return { model: modelRef.current, version, meta, ready, send, models };
}

export type SessionHandle = ReturnType<typeof useSession>;
