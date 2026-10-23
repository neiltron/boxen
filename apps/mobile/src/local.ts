// The page's side of the agent worker: a Transport for the shared session
// client (one MessageChannel per socket, JSON strings both ways, as on a
// WebSocket) and the key requests.
import { sessionClient, type Transport } from "@boxen/client";
import type { Connected, WorkerRequest } from "./agent.worker.ts";

const worker = new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });

const workerTransport: Transport = (_url, on) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (e) => on.message(e.data);
  worker.postMessage({ type: "connect" } satisfies WorkerRequest, [port2]);
  queueMicrotask(on.open); // after reconnecting() has taken the wire this returns
  let open = true;
  return {
    send(data) {
      if (!open) throw new Error("socket not open");
      port1.postMessage(data);
    },
    close() {
      open = false;
      port1.postMessage("close");
      port1.close();
    },
  };
};

export const localSession = sessionClient("local:", { transport: workerTransport });

function ask<T>(request: WorkerRequest): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    port1.onmessage = ({ data }) => {
      port1.close();
      if ("error" in data) reject(new Error(data.error));
      else resolve(data.value);
    };
    worker.postMessage(request, [port2]);
  });
}

export const listKeys = () => ask<Connected[]>({ type: "keys" });
export const setKey = (provider: string, key: string) => ask<Connected[]>({ type: "key", provider, key });
export const startLogin = (provider: string) => ask<string>({ type: "login", provider });
export const finishLogin = (redirectUrl: string) => ask<Connected[]>({ type: "loginFinish", redirectUrl });
