import { useEffect, useMemo, useSyncExternalStore } from "react";
import { WS_BASE } from "@/lib/api";
import { sessionClient } from "@/lib/session-client";

// React's binding to the session client (lib/session-client.ts): its state
// plus its commands, connected while the component is mounted.
export function useSession(id: string) {
  const client = useMemo(() => sessionClient(`${WS_BASE}/api/session/${id}/ws`), [id]);
  useEffect(() => client.connect(), [client]);
  const state = useSyncExternalStore(client.subscribe, client.state);
  const { prompt, abort, configure, listModels } = client;
  return { ...state, prompt, abort, configure, listModels };
}

export type SessionHandle = ReturnType<typeof useSession>;
