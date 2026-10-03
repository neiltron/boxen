import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { liveSocket } from "./src/lib/live-socket.ts";

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(data: string) { this.onmessage?.({ data }); }
}
let documentTarget: EventTarget & { visibilityState: string };
let windowTarget: EventTarget;
let connection: ReturnType<typeof liveSocket>;
let received: string[];
let disconnects: number;
const latest = () => FakeSocket.sockets.at(-1)!;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  windowTarget = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  FakeSocket.sockets = [];
  received = [];
  disconnects = 0;
  connection = liveSocket("ws://test", {
    open: () => { connection.send({ type: "sub" }); },
    message: (event) => received.push(event.data),
    disconnect: () => { disconnects++; },
  });
});
afterEach(() => { connection.close(); mock.timers.reset(); });

test("subscribes, pings, and replaces a half-open socket when pong is missing", () => {
  latest().open();
  assert.equal(latest().sent[0], '{"type":"sub"}');
  mock.timers.tick(25_000);
  assert.equal(latest().sent.at(-1), '{"type":"ping"}');
  mock.timers.tick(10_000);
  assert.equal(latest().readyState, 3);
  assert.equal(connection.send({ type: "prompt" }), false);
  mock.timers.tick(1000);
  assert.equal(FakeSocket.sockets.length, 2);
});

test("a pong keeps an idle connection alive", () => {
  latest().open();
  mock.timers.tick(25_000);
  latest().message('{"type":"pong"}');
  mock.timers.tick(10_000);
  assert.equal(FakeSocket.sockets.length, 1);
  assert.equal(latest().readyState, 1);
});

test("foreground/online replace stale sockets without accepting their callbacks", () => {
  const old = latest();
  old.open();
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(FakeSocket.sockets.length, 1);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(FakeSocket.sockets.length, 2);
  old.message("stale");
  old.close();
  latest().open();
  latest().message("fresh");
  assert.deepEqual(received, ["fresh"]);
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(FakeSocket.sockets.length, 3);
  assert.ok(disconnects >= 2);
});

test("connection timeout and failed upgrades back off; cleanup cancels all retries", () => {
  mock.timers.tick(15_000);
  mock.timers.tick(1000);
  assert.equal(FakeSocket.sockets.length, 2);
  latest().onerror?.();
  mock.timers.tick(1999);
  assert.equal(FakeSocket.sockets.length, 2);
  mock.timers.tick(1);
  assert.equal(FakeSocket.sockets.length, 3);
  connection.close();
  mock.timers.tick(120_000);
  windowTarget.dispatchEvent(new Event("online"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(FakeSocket.sockets.length, 3);
});

test("offline immediately blocks sends until network recovery", () => {
  latest().open();
  windowTarget.dispatchEvent(new Event("offline"));
  assert.equal(connection.send({ type: "prompt" }), false);
  mock.timers.tick(2000);
  assert.equal(FakeSocket.sockets.length, 1);
  windowTarget.dispatchEvent(new Event("online"));
  latest().open();
  assert.equal(connection.send({ type: "prompt" }), true);
});

test("pagehide releases the socket, BFCache pageshow reconnects", () => {
  latest().open();
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(latest().readyState, 3);
  mock.timers.tick(2000);
  assert.equal(FakeSocket.sockets.length, 1);
  windowTarget.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  assert.equal(FakeSocket.sockets.length, 2);
});
