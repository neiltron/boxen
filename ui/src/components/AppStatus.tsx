import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";

export function AppStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW: (_url, value) => setRegistration(value),
    onRegisterError: (error) => console.warn("App shell caching unavailable", error),
  });

  useEffect(() => {
    const network = () => setOnline(navigator.onLine);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, []);

  useEffect(() => {
    // Long-lived standalone windows need update checks too, not just on load.
    // Checking only installs a waiting worker; activation/reload is opt-in.
    const check = () => {
      if (navigator.onLine && document.visibilityState === "visible") {
        void registration?.update().catch(() => {});
      }
    };
    const timer = setInterval(check, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [registration]);

  if (online && !needRefresh) return null;
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs">
      {!online ? "Offline — reconnect to load sessions and send messages." : <>
        <span>An app update is ready.</span>
        <Button size="sm" onClick={() => void updateServiceWorker(true)}>Reload to update</Button>
        <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>Later</Button>
      </>}
    </div>
  );
}
