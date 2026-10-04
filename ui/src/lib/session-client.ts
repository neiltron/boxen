// The session client: one handle on a Session cell. Behind it sit the
// reconnecting socket, the reducer that folds agent events into the chat
// model (events.ts), the facts derived while folding, and the command
// vocabulary of src/session.js webSocketMessage. No React here: the hook in
// hooks/useSession.ts is a thin binding, and session.check.ts drives this
// module through a scripted socket. (Relative .ts imports, so Node can load
// it without Vite's aliases.)
//
// Interface, beyond the types:
// - connect() joins and keeps rejoining until the function it returns runs.
//   A join is `sub`, then meta, a snapshot, ready. `ready` drops to false the
//   moment the socket does (also how the cell hands over a session it
//   reopened: it closes every socket, and the rejoin takes the fresh snapshot). The transcript on screen stays until the next
//   ready, which swaps in a model rebuilt from that join's snapshot.
// - Commands need `ready`. Otherwise they return false and send nothing.
//   Nothing is queued: a prompt held through an outage could land long
//   after the user has moved on, so the composer keeps the draft and the
//   resend is theirs to make. (Each prompt's requestId lets the cell
//   dedupe a resend; this client never resends on its own.)
// - `models` is the login's list; it survives reconnects (every listModels
//   refreshes it). `meta` is replaced by each join's meta frame.
// - An `error` frame is the cell rejecting a command, not an agent event: it
//   becomes an error line in the transcript, and stays out of the Events log.
import { appendError, applyEvent, emptyModel, type AgentState, type ChatModel } from "./events.ts";
import { reconnecting, type SocketDeps } from "./socket.ts";
import type { ModelInfo, SessionMeta } from "./api.ts";

export type { AgentState, Block, ChatItem, ChatModel, LoggedEvent } from "./events.ts";

export interface SessionState {
  model: ChatModel; // mutated in place; the state object changes with it
  meta: SessionMeta | null;
  ready: boolean;
  models: ModelInfo[] | null;
  saved: { id: string } | null; // the latest artifact save that arrived live, not in a snapshot
}

export interface SessionCommands {
  prompt(text: string): boolean; // steers when the agent is running
  abort(): boolean;
  configure(agent: AgentState): boolean; // applies from the next model request
  listModels(): boolean; // the answer lands in `models`
}

export interface SessionClient extends SessionCommands {
  connect(): () => void;
  state(): SessionState; // a new object after every change
  subscribe(listener: () => void): () => void;
}

// What the browser sends; `sub` and `ping` belong to the socket.
type Command =
  | { type: "prompt"; message: string; requestId: string } // the cell dedupes a resend by requestId
  | { type: "abort" }
  | { type: "configure"; model?: AgentState["model"]; thinkingLevel?: string }
  | { type: "models" };

// What the cell sends back.
type Frame =
  | { type: "meta"; meta: SessionMeta }
  | { type: "events"; events: { type: string }[] }
  | { type: "ready" }
  | { type: "models"; models: ModelInfo[] }
  | { type: "error"; error: string };

export const emptySession = (): SessionState =>
  ({ model: emptyModel(), meta: null, ready: false, models: null, saved: null });

export function sessionClient(url: string, deps?: SocketDeps): SessionClient {
  let state = emptySession();
  let joining: ChatModel | null = null; // built from the snapshot until ready
  let socket: ReturnType<typeof reconnecting<Frame>> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: Partial<SessionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const receive = (frame: Frame) => {
    switch (frame.type) {
      case "meta":
        return set({ meta: frame.meta });
      case "models":
        return set({ models: frame.models });
      case "events": {
        if (joining) {
          for (const ev of frame.events) applyEvent(joining, ev);
          return;
        }
        const { model } = state;
        const saves = model.artifacts.length;
        for (const ev of frame.events) applyEvent(model, ev);
        return set(model.artifacts.length > saves ? { saved: { id: model.artifacts.at(-1)! } } : {});
      }
      case "ready": {
        const model = joining ?? state.model;
        joining = null;
        return set({ model, ready: true });
      }
      case "error":
        appendError(state.model, frame.error);
        return set({});
    }
  };

  const command = (cmd: Command) => state.ready && !!socket?.send(cmd);

  return {
    connect() {
      const self = reconnecting<Frame>(url, {
        open: () => { joining = emptyModel(); },
        message: receive,
        drop: () => {
          joining = null;
          if (state.ready) set({ ready: false });
        },
      }, deps);
      socket = self;
      return () => {
        self.close();
        if (socket !== self) return;
        socket = null;
        joining = null;
        if (state.ready) set({ ready: false });
      };
    },
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: (text) => command({ type: "prompt", message: text, requestId: crypto.randomUUID() }),
    abort: () => command({ type: "abort" }),
    configure: (agent) => command({ type: "configure", model: agent.model, thinkingLevel: agent.thinkingLevel }),
    listModels: () => command({ type: "models" }),
  };
}
