import { createContext, useContext } from "react";
import type { SessionHandle } from "@/hooks/useSession";

export type PanelView = "artifacts" | "changes" | "preview" | "terminal" | "events";

// What every docked view needs, wherever the user drags it.
export interface SessionContextValue {
  sessionId: string;
  session: SessionHandle;
  artifact: string | null;
  setArtifact: (id: string | null) => void;
  /** Bring a panel view forward (restoring its panel if hidden). */
  open: (view: PanelView, artifactId?: string) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSessionContext outside a SessionView");
  return value;
}
