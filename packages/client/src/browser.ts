// The browser's WebSocket as a Transport (socket.ts).
import type { Transport } from "./socket.ts";

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
