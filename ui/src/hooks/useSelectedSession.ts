import { useEffect, useState } from "react";

const KEY = "pids.selectedSession";

function fromURL() {
  return new URL(location.href).searchParams.get("session") || null;
}

// The URL is tab-local (and shareable); storage is only a fallback for a fresh
// launch from the home screen. Never clear selection based on a loading list.
export function useSelectedSession() {
  const [selected, setSelected] = useState<string | null>(() => {
    if (new URL(location.href).searchParams.has("session")) return fromURL();
    try { return localStorage.getItem(KEY); } catch { return null; }
  });

  useEffect(() => {
    const pop = () => setSelected(fromURL());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    // Also pin the restored session in this tab before another tab changes
    // the home-screen fallback. replaceState doesn't add a fake history step.
    if (selected) url.searchParams.set("session", selected);
    else url.searchParams.delete("session");
    history.replaceState(null, "", url);
    try {
      if (selected) localStorage.setItem(KEY, selected);
      else localStorage.removeItem(KEY);
    } catch { /* private mode / storage denied: the URL still works */ }
  }, [selected]);

  const select = (id: string) => {
    if (id === selected) return;
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    history.pushState(null, "", url);
    setSelected(id);
  };
  return [selected, select] as const;
}
