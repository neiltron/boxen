// A suspended mobile browser can retain a WebSocket that looks OPEN but is
// dead. Rejoin on foreground/network recovery, never reload the document.
// One owner for timers/listeners also makes React StrictMode cleanup safe.
export function liveSocket(url: string, handlers: {
  open: () => void;
  message: (event: MessageEvent) => void;
  disconnect?: () => void;
}) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const send = (message: object): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  };
  const detach = () => {
    clearTimeout(retry);
    clearTimeout(deadline);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = null;
    }
    handlers.disconnect?.();
  };
  const reconnect = () => {
    detach();
    if (!stopped) retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30_000));
  };
  const connect = () => {
    if (stopped) return;
    detach();
    const socket = new WebSocket(url);
    ws = socket;
    deadline = setTimeout(reconnect, 15_000);
    socket.onopen = () => {
      clearTimeout(deadline);
      attempts = 0;
      handlers.open();
    };
    socket.onmessage = (event) => {
      // Any response proves the connection is alive. The server echoes ping
      // even when there are no agent events to deliver.
      clearTimeout(deadline);
      handlers.message(event);
    };
    socket.onclose = reconnect;
    socket.onerror = reconnect;
  };
  const resume = () => {
    if (document.visibilityState !== "visible") return;
    attempts = 0;
    connect();
  };
  const pageShow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
  const pageHide = () => detach();
  const heartbeat = setInterval(() => {
    if (document.visibilityState !== "visible" || !send({ type: "ping" })) return;
    clearTimeout(deadline);
    deadline = setTimeout(reconnect, 10_000);
  }, 25_000);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  window.addEventListener("offline", pageHide);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("pagehide", pageHide);
  connect();

  return {
    send,
    close() {
      stopped = true;
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("pagehide", pageHide);
      detach();
    },
  };
}
