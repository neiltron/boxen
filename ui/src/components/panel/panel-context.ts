import { createContext, useContext } from "react";
import type { PanelTab } from "@/components/panel/Panel";

// Lets chat items open things in the panel (e.g. an artifact a tool call made).
export const PanelContext = createContext<{ open: (tab: PanelTab, artifactId?: string) => void }>({ open: () => {} });
export const usePanel = () => useContext(PanelContext);
