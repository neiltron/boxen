// A JSON WebSocket to a cell that keeps rejoining: the piece the session
// client and the Directory hook share. It sends `sub` on every open (both
// cells push nothing until asked), retries 2 s after any drop, and pings every
// 25 s while open. Neither cell answers the ping; it is traffic on an idle
// socket, for the proxies on the way (Vite's dev proxy, Caddy, Tailscale
// Serve) that may cut quiet connections.
//
// The transport is the seam, with two adapters: the browser's WebSocket
// (browserSocket) and the scripted socket in session.check.ts. The clock is
// injected too, so checks drive retries and pings without waiting.

export interface Wire {
  send(data: string): void; // throws when the socket is not open
  close(): void;
}
export type Transport = (url: string, on: { open(): void; message(data: string): void; close(): void }) => Wire;

export interface Clock {
  after(ms: number, fn: () => void): () => void; // returns cancel
  every(ms: number, fn: () => void): () => void;
}

export interface SocketDeps {
  transport?: Transport;
  clock?: Clock;
}

export const browserSocket: Transport = (url, on) => {
  const ws = new WebSocket(url);
  ws.onopen = () => on.open();
  ws.onmessage = (e) => on.message(e.data);
  ws.onclose = () => on.close();
  return {
    // A CLOSING socket drops frames silently; refuse instead.
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      ws.send(data);
    },
    close: () => ws.close(),
  };
};

export const realClock: Clock = {
  after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

export const RETRY_MS = 2000;
export const PING_MS = 25_000;

// `send` returns false (and sends nothing) unless the socket is open; the
// Wire throws for that. `drop` runs when an open or opening socket goes away;
// `close` stops for good.
export function reconnecting<Frame>(
  url: string,
  on: { open?(): void; message(frame: Frame): void; drop?(): void },
  { transport = browserSocket, clock = realClock }: SocketDeps = {},
) {
  let wire: Wire | null = null;
  let cancelRetry = () => {};

  const send = (msg: object): boolean => {
    if (!wire) return false;
    try { wire.send(JSON.stringify(msg)); return true; } catch { return false; }
  };

  const connect = () => {
    // Events from a socket that was replaced or closed are ignored.
    const self: Wire = transport(url, {
      open() {
        if (wire !== self) return;
        on.open?.();
        send({ type: "sub" });
      },
      message(data) {
        if (wire !== self) return;
        let frame: Frame;
        try { frame = JSON.parse(data); } catch { return; }
        on.message(frame);
      },
      close() {
        if (wire !== self) return;
        wire = null;
        on.drop?.();
        cancelRetry = clock.after(RETRY_MS, connect);
      },
    });
    wire = self;
  };

  const stopPing = clock.every(PING_MS, () => send({ type: "ping" }));
  connect();

  return {
    send,
    close() {
      cancelRetry();
      stopPing();
      const w = wire;
      wire = null; // its close event, if any, is now ignored
      w?.close();
    },
  };
}
