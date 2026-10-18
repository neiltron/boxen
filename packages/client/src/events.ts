// Reducer that folds pi-durable's agent events (watchEvents) into renderable
// chat items. Each tab gets a `snapshot` first — the committed transcript plus
// the in-flight generation and tool slots — then one batch of deltas per
// commit. User messages and tool results arrive as messages like any other.
// Internal to the session client (session-client.ts), which decides when a
// model is built and swapped in; components only read the ChatModel.
import type { AgentState } from "./protocol.ts";

export type ToolState = "building" | "running" | "done";

export type Block =
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "thinking"; text: string; streaming: boolean }
  | {
      kind: "tool";
      toolId: string | null;
      name: string;
      argsText: string;
      args: unknown;
      output: string;
      isError: boolean;
      state: ToolState;
      artifactId?: string; // what an artifact tool call saved
    };

export type ChatItem =
  | { kind: "user"; seq: number; text: string; steer: boolean }
  | { kind: "assistant"; seq: number; blocks: Block[]; streaming: boolean }
  | { kind: "system"; seq: number; text: string; level: "info" | "error" };

export interface LoggedEvent {
  n: number;
  ts: number;
  ev: { type: string } & Record<string, unknown>;
}

export interface ChatModel {
  items: ChatItem[];
  running: boolean;
  assistantSeq: number | null; // active message, independent of interleaved notes
  seq: number; // local React keys; the cell no longer numbers events
  agent: AgentState;
  log: LoggedEvent[]; // raw events for the Events tab, newest last
  logged: number;
  // Facts the panel follows, counted as tool calls finish (see settle).
  artifacts: string[]; // artifact ids saved in this transcript, oldest first
  mutations: number; // finished calls that may have touched files
}

const LOG_LIMIT = 1000;

export function emptyModel(): ChatModel {
  return { items: [], assistantSeq: null, running: false, seq: 0, agent: {}, log: [], logged: 0, artifacts: [], mutations: 0 };
}

function currentAssistant(m: ChatModel): Extract<ChatItem, { kind: "assistant" }> | null {
  const item = m.items.find((item) => item.seq === m.assistantSeq);
  return item?.kind === "assistant" ? item : null;
}

function findTool(m: ChatModel, toolId: string) {
  for (let i = m.items.length - 1; i >= 0; i--) {
    const item = m.items[i];
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.kind === "tool" && b.toolId === toolId) return b;
    }
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toBlock(c: any, prev?: Block): Block {
  if (c?.type === "text") return { kind: "text", text: c.text ?? "", streaming: false };
  if (c?.type === "thinking") return { kind: "thinking", text: c.thinking ?? "", streaming: false };
  if (c?.type === "toolCall") {
    const p = prev?.kind === "tool" && prev.toolId === c.id ? prev : null;
    return {
      kind: "tool", toolId: c.id ?? null, name: c.name ?? "tool",
      argsText: "", args: c.arguments ?? null,
      output: p?.output ?? "", isError: p?.isError ?? false, state: p?.state ?? "building",
      artifactId: p?.artifactId,
    };
  }
  return { kind: "text", text: "", streaming: false };
}

function push(m: ChatModel, item: any) {
  m.items.push({ ...item, seq: m.seq++ });
}

// A line that is not an agent event: a command the cell rejected.
export function appendError(m: ChatModel, text: string) {
  push(m, { kind: "system", level: "error", text });
}

// Calls that may change files; each finished one refetches the diff.
const MUTATING = new Set(["write", "edit", "bash"]);

// A tool call's result, from tool_execution_end or a toolResult message
// (`msg` is missing when the call ended without one). The panel's facts
// count a call once, the first time it finishes.
function settle(m: ChatModel, b: Extract<Block, { kind: "tool" }>, msg: any) {
  if (msg) b.output = textOf(msg.content);
  b.isError = msg ? !!msg.isError : true;
  if (typeof msg?.details?.artifactId === "string") b.artifactId = msg.details.artifactId;
  if (b.state === "done") return;
  b.state = "done";
  if (MUTATING.has(b.name)) m.mutations++;
  if (b.name === "artifact" && !b.isError && b.artifactId) m.artifacts.push(b.artifactId);
}

// One whole message: from a committed entry, a snapshot, or message_start.
function applyMessage(m: ChatModel, msg: any, streaming: boolean) {
  if (msg?.role === "user") {
    push(m, { kind: "user", text: textOf(msg.content), steer: m.running });
  } else if (msg?.role === "assistant") {
    const blocks = (msg.content ?? []).map((c: any) => ({ ...toBlock(c), ...(streaming && c?.type !== "toolCall" ? { streaming } : {}) }));
    m.assistantSeq = m.seq;
    push(m, { kind: "assistant", blocks, streaming });
    if (!streaming) endAssistant(m, msg);
  } else if (msg?.role === "toolResult") {
    const b = findTool(m, msg.toolCallId);
    if (b) settle(m, b, msg);
  }
}

// Authoritative content replaces streamed blocks; tool progress is kept.
function endAssistant(m: ChatModel, msg: any) {
  const a = currentAssistant(m);
  if (!a) return;
  a.blocks = (msg.content ?? []).map((c: any) =>
    toBlock(c, a.blocks.find((b) => b.kind === "tool" && b.toolId === c.id)));
  a.streaming = false;
  m.assistantSeq = null;
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    // No result is coming for a call the run left behind; a Stop that failed
    // the Harness ends this way, and so does its snapshot afterwards.
    for (const b of a.blocks) if (b.kind === "tool" && b.state !== "done") settle(m, b, undefined);
    push(m, { kind: "system", level: msg.stopReason === "error" ? "error" : "info",
      text: msg.errorMessage ?? msg.stopReason });
  }
}

// Session setup lines (cloning, failures) the cell writes into the transcript.
function applyNote(m: ChatModel, entry: any) {
  if (entry?.kind === "app.note") push(m, { kind: "system", level: entry.data?.level ?? "info", text: entry.data?.text ?? "" });
}

export function applyEvent(m: ChatModel, ev: any): void {
  m.log.push({ n: m.logged++, ts: Date.now(), ev });
  if (m.log.length > LOG_LIMIT) m.log.splice(0, m.log.length - LOG_LIMIT);
  switch (ev.type) {
    case "snapshot": {
      Object.assign(m, { items: [], assistantSeq: null, running: false, seq: 0, artifacts: [], mutations: 0 });
      m.agent = ev.agent ?? {};
      for (const entry of ev.entries) {
        applyNote(m, entry);
        for (const msg of entry.model ?? []) applyMessage(m, msg, false);
      }
      m.running = !!ev.run;
      if (ev.generation?.message) applyMessage(m, ev.generation.message, true);
      for (const slot of ev.tools ?? []) {
        const b = findTool(m, slot.callId);
        if (b && slot.status !== "done") {
          b.state = slot.status === "running" ? "running" : "building";
          b.output = slot.output ?? "";
        }
      }
      return;
    }

    case "entry_appended":
      applyNote(m, ev.entry);
      return;

    case "agent_changed":
      m.agent = ev.agent ?? {};
      return;

    case "run_start":
      m.running = true;
      return;

    case "run_end": {
      m.running = false;
      const a = currentAssistant(m);
      if (a) {
        a.streaming = false;
        for (const block of a.blocks) if (block.kind !== "tool") block.streaming = false;
      }
      m.assistantSeq = null;
      return;
    }

    case "message_start":
      applyMessage(m, ev.message, ev.message?.role === "assistant");
      return;

    case "message_update": {
      const a = currentAssistant(m);
      if (!a) return;
      for (const c of ev.changes ?? []) {
        const i = c.contentIndex;
        const b = a.blocks[i];
        switch (c.type) {
          case "text_start":
          case "thinking_start":
          case "toolcall_start":
          case "block":
            a.blocks[i] = toBlock(c.block, b);
            if (c.type !== "block" && a.blocks[i].kind !== "tool") (a.blocks[i] as any).streaming = true;
            break;
          case "text_delta":
          case "thinking_delta":
            if (b && b.kind !== "tool") b.text += c.delta ?? "";
            break;
          case "toolcall_delta":
            if (b?.kind === "tool") b.argsText += c.delta ?? "";
            break;
          case "message":
            a.blocks = (c.message?.content ?? []).map((x: any, j: number) => toBlock(x, a.blocks[j]));
            break;
        }
      }
      return;
    }

    case "message_end": {
      const msg = ev.entry?.model?.[0];
      if (msg?.role === "assistant") endAssistant(m, msg);
      return;
    }

    case "tool_execution_start": {
      const b = findTool(m, ev.toolCallId);
      if (b) {
        b.state = "running";
        b.name = ev.toolName ?? b.name;
        if (ev.args !== undefined) b.args = ev.args;
      }
      return;
    }

    case "tool_execution_update": {
      const b = findTool(m, ev.toolCallId);
      const o = ev.output;
      if (!b || !o) return;
      if ("set" in o) b.output = o.set;
      else b.output = b.output.slice(o.trimStart ?? 0) + (o.append ?? "");
      return;
    }

    case "tool_execution_end": {
      const b = findTool(m, ev.toolCallId);
      if (b) settle(m, b, ev.entry?.model?.[0]);
      return;
    }

    case "submission":
      if (ev.record?.status === "unanswered" && ev.record.reason !== "model_error") {
        push(m, { kind: "system", level: "error", text: ev.record.detail ?? ev.record.reason });
      }
      return;

    case "auto_retry_start":
      push(m, { kind: "system", level: "info", text: `retrying (attempt ${ev.attempt}): ${ev.errorMessage}` });
      return;

    case "task_failed":
      push(m, { kind: "system", level: "error", text: ev.message });
      return;

    // turn_*, inbox_update, usage_changed, agent_changed, compaction_*:
    // nothing to render for now.
    default:
      return;
  }
}
