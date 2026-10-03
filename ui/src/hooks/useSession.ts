import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE, type ModelInfo, type SessionMeta } from "@/lib/api";
import { applyEvent, emptyModel, type ChatModel } from "@/lib/events";
import { liveSocket } from "@/lib/live-socket";

// Keep the displayed transcript while disconnected. Build the joining
// snapshot separately, then swap it in atomically at "ready"; clearing the
// visible model at connect time used to destroy the reader's scroll position.
export function useSession(id: string | null) {
  const modelRef = useRef<ChatModel>(emptyModel());
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const connectionRef = useRef<ReturnType<typeof liveSocket> | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    modelRef.current = emptyModel();
    setMeta(null);
    setModels(null);
    setReady(false);
    setLoaded(false);
    readyRef.current = false;
    setVersion((v) => v + 1);
    if (!id) return;

    let joining: ChatModel | null = null;
    const connection = liveSocket(`${WS_BASE}/api/session/${encodeURIComponent(id)}/ws`, {
      open() {
        joining = emptyModel();
        connection.send({ type: "sub" });
      },
      disconnect() {
        readyRef.current = false;
        setReady(false);
      },
      message(e) {
        const m = JSON.parse(e.data);
        if (m.type === "events") {
          for (const ev of m.events) applyEvent(joining ?? modelRef.current, ev);
          if (!joining) setVersion((v) => v + 1);
        } else if (m.type === "error") {
          applyEvent(modelRef.current, m);
          setVersion((v) => v + 1);
        } else if (m.type === "models") {
          setModels(m.models);
        } else if (m.type === "meta") {
          setMeta(m.meta);
        } else if (m.type === "ready") {
          if (joining) modelRef.current = joining;
          joining = null;
          readyRef.current = true;
          setReady(true);
          setLoaded(true);
          setVersion((v) => v + 1);
        }
      },
    });
    connectionRef.current = connection;
    return () => {
      connection.close();
      connectionRef.current = null;
    };
  }, [id]);

  // No offline command queue: never silently drop a draft or replay a prompt.
  const send = useCallback((cmd: object): boolean => {
    return readyRef.current && (connectionRef.current?.send(cmd) ?? false);
  }, []);

  return { id, model: modelRef.current, version, meta, ready, loaded, send, models };
}

export type SessionHandle = ReturnType<typeof useSession>;
