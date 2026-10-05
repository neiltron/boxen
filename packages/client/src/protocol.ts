// The Session WebSocket protocol: the JSON messages on /api/session/{id}/ws
// (sessionSocket in openapi.json, which describes only the upgrade). One
// definition for both ends: the session client sends SessionCommand and folds
// SessionFrame, and the Session cell (apps/worker/src/session.js) handles
// exactly SESSION_COMMANDS, which apps/worker/protocol.check.mjs holds it to.
import type { components } from "./openapi.ts";

type Session = components["schemas"]["Session"];

// The agent's model and reasoning level, as `configure` sets them and
// snapshots and agent_changed events report them.
export interface AgentState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
}

// What a client sends. The cell sends nothing until `sub`.
export type SessionCommand =
  | { type: "sub" } // join: meta, a snapshot, ready, then live events
  | { type: "ping" } // traffic on an idle socket, for proxies; never answered
  | { type: "prompt"; message: string; requestId: string } // steers when the agent is running; the cell dedupes a resend by requestId
  | { type: "steer"; message: string; requestId: string } // prompt's old name; the session client never sends it
  | { type: "abort" }
  | { type: "configure"; model?: AgentState["model"]; thinkingLevel?: string } // applies from the next model request
  | { type: "models" } // answered with a `models` frame
  | { type: "rename"; name: string }; // as PATCH /api/session/{id}; the session client never sends it

// What the cell sends back. `events` carries pi-durable's watchEvents
// stream: a `snapshot` first on each join, then batches of deltas.
export type SessionFrame =
  | { type: "meta"; meta: Session } // on each join, and after every metadata change
  | { type: "events"; events: { type: string }[] }
  | { type: "ready" } // the join is complete
  | { type: "models"; models: ModelInfo[] }
  | { type: "error"; error: string; requestId?: string }; // the cell rejected a command; requestId when it refused that prompt

// Every command type, at runtime. A Record so the compiler fails when this
// and SessionCommand disagree in either direction.
const commands: Record<SessionCommand["type"], true> =
  { sub: true, ping: true, prompt: true, steer: true, abort: true, configure: true, models: true, rename: true };
export const SESSION_COMMANDS = Object.keys(commands) as SessionCommand["type"][];
