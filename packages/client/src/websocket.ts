// The standard WebSocket as a Transport (socket.ts), in the browser and in
// Node alike: Node 22+ has the same global WebSocket, so this one adapter is
// the Node transport too. tsconfig.core.json holds it to Node's library.
import type { Transport } from "./socket.ts";

export const webSocketTransport: Transport = (url, on) => {
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
