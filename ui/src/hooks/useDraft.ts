import { useState } from "react";

// ChatView is keyed by session. Keep unsent text tab-local across a browser
// reload/update, not in the service-worker cache or an offline send queue.
export function useDraft(sessionId: string | null) {
  const key = `pids.draft.${sessionId}`;
  const [draft, setValue] = useState(() => {
    try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; }
  });
  const setDraft = (value: string) => {
    setValue(value);
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch { /* keep editing when storage is unavailable */ }
  };
  return [draft, setDraft] as const;
}
