import { createContext, useContext } from "react";
import type { SessionMeta } from "@/lib/api";

type Actions = {
  rename: (session: SessionMeta) => void;
  archive: (session: SessionMeta, archived: boolean) => Promise<void>;
  pending: boolean;
};
export const SessionActionsContext = createContext<Actions | null>(null);
export function useSessionActions() {
  const actions = useContext(SessionActionsContext);
  if (!actions) throw new Error("SessionActionsProvider missing");
  return actions;
}

