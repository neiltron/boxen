// The session client: one handle on a Session cell. Behind it sit the
// reconnecting socket (socket.ts), the reducer that folds agent events into
// the chat model (events.ts), the facts derived while folding, and the
// commands of the Session WebSocket protocol (protocol.ts). No React or DOM
// here: the caller passes the transport, the web app's useSession hook is a
// thin binding, and session.check.ts drives this module through a scripted
// socket.
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
// - run() is one turn for a headless caller (a script, the CLI, the MCP
//   server): it waits for `ready`, sends the prompt, and resolves with a
//   TurnResult once the cell settles that prompt (pi-durable's `submission`
//   event for its requestId). Progress is the state, as for the web app:
//   subscribe() and read the reply growing in state().model. Its `signal`
//   cancels: before the prompt goes out, nothing is sent; after, it sends
//   `abort`, and the turn resolves as the cell settles it, normally
//   `aborted`. A drop after the prompt went out resolves `disconnected` at
//   once: the cell runs the turn on durably, but a rejoin's snapshot carries
//   no submission records, so it cannot tell how a turn that ended meanwhile
//   was settled. The caller decides (check the Session later, or abort it).
//   run() never resends.
import { appendError, applyEvent, emptyModel, type ChatModel } from "./events.ts";
import type { components } from "./openapi.ts";
import type { AgentState, ModelInfo, SessionCommand, SessionFrame } from "./protocol.ts";
import { reconnecting, type SocketDeps } from "./socket.ts";

export type { Block, ChatItem, ChatModel, LoggedEvent } from "./events.ts";

type SessionMeta = components["schemas"]["Session"];

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

export type TurnResult =
  | { status: "done"; text: string } // the text of the turn's last assistant message
  | { status: "error"; error: string } // the cell refused the prompt, or the turn failed (no model, model error, …)
  | { status: "aborted" } // anyone's abort, or this run's signal
  | { status: "disconnected" }; // the socket dropped mid-turn; the turn goes on in the cell

export interface SessionClient extends SessionCommands {
  connect(): () => void;
  state(): SessionState; // a new object after every change
  subscribe(listener: () => void): () => void;
  run(text: string, options?: { signal?: AbortSignal }): Promise<TurnResult>; // needs connect()
}

// The fields of pi-durable's SubmissionRecord a turn ends on.
type Submission = { requestId?: string; status: string; reason?: string; detail?: unknown };

const replyText = (model: ChatModel) => {
  const reply = model.items.findLast((item) => item.kind === "assistant");
  return reply?.kind === "assistant" ? reply.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n") : "";
};

export const emptySession = (): SessionState =>
  ({ model: emptyModel(), meta: null, ready: false, models: null, saved: null });

export function sessionClient(url: string, deps: SocketDeps): SessionClient {
  let state = emptySession();
  let joining: ChatModel | null = null; // built from the snapshot until ready
  let socket: ReturnType<typeof reconnecting<SessionFrame>> | null = null;
  const listeners = new Set<() => void>();
  const turns = new Set<(frame: SessionFrame | null) => void>(); // run()s in flight; null: the socket dropped

  const set = (next: Partial<SessionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const fold = (frame: SessionFrame) => {
    switch (frame.type) {
      case "meta":
        // A subscription snapshot can race a mutation broadcast while the
        // server opens the Harness. Never replace newer metadata with it.
        if ((state.meta?.metadataRevision ?? 0) > (frame.meta.metadataRevision ?? 0)) return;
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

  // Turns see each frame after it is folded, so a settled turn reads its reply.
  const receive = (frame: SessionFrame) => {
    fold(frame);
    for (const turn of [...turns]) turn(frame);
  };
  const dropped = () => {
    joining = null;
    if (state.ready) set({ ready: false });
    for (const turn of [...turns]) turn(null);
  };

  const command = (cmd: SessionCommand) => state.ready && !!socket?.send(cmd);

  return {
    connect() {
      const self = reconnecting<SessionFrame>(url, {
        open: () => { joining = emptyModel(); },
        message: receive,
        drop: dropped,
      }, deps);
      socket = self;
      return () => {
        self.close();
        if (socket !== self) return;
        socket = null;
        dropped();
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
    run: (text, { signal } = {}) => new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      let sent = false;
      let admitted = false; // the cell took the prompt: its submission arrived
      const end = (result: TurnResult) => {
        turns.delete(watch);
        signal?.removeEventListener("abort", cancel);
        resolve(result);
      };
      const send = () => { sent = command({ type: "prompt", message: text, requestId }); };
      const watch = (frame: SessionFrame | null) => {
        if (!sent) return send(); // a frame while ready, or the join's own `ready`
        if (!frame) return end({ status: "disconnected" });
        // An error frame goes only to the socket whose command failed.
        if (frame.type === "error" && !admitted) return end({ status: "error", error: frame.error });
        if (frame.type !== "events") return;
        for (const ev of frame.events) {
          const record = (ev as { record?: Submission }).record;
          if (ev.type !== "submission" || record?.requestId !== requestId) continue;
          admitted = true;
          if (record.status === "done") return end({ status: "done", text: replyText(state.model) });
          if (record.status !== "unanswered") continue; // queued, placed
          if (record.reason === "aborted") return end({ status: "aborted" });
          return end({ status: "error", error: typeof record.detail === "string" ? record.detail : record.reason ?? "unanswered" });
        }
      };
      const cancel = () => { if (sent) command({ type: "abort" }); else end({ status: "aborted" }); };
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel);
      turns.add(watch);
      send();
    }),
  };
}
