import { useEffect, useMemo, useSyncExternalStore } from "react";
import { webSocketTransport, sessionClient } from "@pi-durable-sessions/client";
import { WS_BASE } from "@/lib/api";

// React's binding to the shared client's session client: its state plus its
// commands, connected over the browser's WebSocket while the component is
// mounted.
export function useSession(id: string) {
  const client = useMemo(() => sessionClient(`${WS_BASE}/api/session/${id}/ws`, { transport: webSocketTransport }), [id]);
  useEffect(() => client.connect(), [client]);
  const state = useSyncExternalStore(client.subscribe, client.state);
  const { prompt, abort, configure, listModels } = client;
  return { ...state, prompt, abort, configure, listModels };
}

export type SessionHandle = ReturnType<typeof useSession>;
