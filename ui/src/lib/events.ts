// Reducer that folds pi-durable's agent events (watchEvents) into renderable
// chat items. Each tab gets a `snapshot` first — the committed transcript plus
// the in-flight generation and tool slots — then one batch of deltas per
// commit. User messages and tool results arrive as messages like any other.

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
    };

export type ChatItem =
  | { kind: "user"; seq: number; text: string; steer: boolean }
  | { kind: "assistant"; seq: number; blocks: Block[]; streaming: boolean }
  | { kind: "system"; seq: number; text: string; level: "info" | "error" };

export interface AgentState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

export interface LoggedEvent {
  n: number;
  ts: number;
  ev: { type: string } & Record<string, unknown>;
}

export interface ChatModel {
  items: ChatItem[];
  running: boolean;
  seq: number; // local React keys; the cell no longer numbers events
  agent: AgentState;
  log: LoggedEvent[]; // raw events for the Events tab, newest last
  logged: number;
}

const LOG_LIMIT = 1000;

export function emptyModel(): ChatModel {
  return { items: [], running: false, seq: 0, agent: {}, log: [], logged: 0 };
}

function currentAssistant(m: ChatModel): Extract<ChatItem, { kind: "assistant" }> | null {
  const last = m.items[m.items.length - 1];
  return last?.kind === "assistant" ? last : null;
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
    };
  }
  return { kind: "text", text: "", streaming: false };
}

function push(m: ChatModel, item: any) {
  m.items.push({ ...item, seq: m.seq++ });
}

// One whole message: from a committed entry, a snapshot, or message_start.
function applyMessage(m: ChatModel, msg: any, streaming: boolean) {
  if (msg?.role === "user") {
    push(m, { kind: "user", text: textOf(msg.content), steer: m.running });
  } else if (msg?.role === "assistant") {
    const blocks = (msg.content ?? []).map((c: any) => ({ ...toBlock(c), ...(streaming && c?.type !== "toolCall" ? { streaming } : {}) }));
    push(m, { kind: "assistant", blocks, streaming });
    if (!streaming) endAssistant(m, msg);
  } else if (msg?.role === "toolResult") {
    const b = findTool(m, msg.toolCallId);
    if (b) {
      b.output = textOf(msg.content);
      b.isError = !!msg.isError;
      b.state = "done";
    }
  }
}

// Authoritative content replaces streamed blocks; tool progress is kept.
function endAssistant(m: ChatModel, msg: any) {
  const a = currentAssistant(m);
  if (!a) return;
  a.blocks = (msg.content ?? []).map((c: any) =>
    toBlock(c, a.blocks.find((b) => b.kind === "tool" && b.toolId === c.id)));
  a.streaming = false;
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    push(m, { kind: "system", level: msg.stopReason === "error" ? "error" : "info",
      text: msg.errorMessage ?? msg.stopReason });
  }
}

export function applyEvent(m: ChatModel, ev: any): void {
  m.log.push({ n: m.logged++, ts: Date.now(), ev });
  if (m.log.length > LOG_LIMIT) m.log.splice(0, m.log.length - LOG_LIMIT);
  switch (ev.type) {
    case "snapshot": {
      Object.assign(m, { items: [], running: false, seq: 0 });
      m.agent = ev.agent ?? {};
      for (const entry of ev.entries) for (const msg of entry.model ?? []) applyMessage(m, msg, false);
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

    case "agent_changed":
      m.agent = ev.agent ?? {};
      return;

    case "run_start":
      m.running = true;
      return;

    case "run_end": {
      m.running = false;
      const a = currentAssistant(m);
      if (a) a.streaming = false;
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
      const msg = ev.entry?.model?.[0];
      if (b) {
        if (msg) b.output = textOf(msg.content);
        b.isError = msg ? !!msg.isError : true;
        b.state = "done";
      }
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

    case "error": // a command the cell rejected (not an agent event)
      push(m, { kind: "system", level: "error", text: ev.error });
      return;

    // turn_*, inbox_update, usage_changed, agent_changed, compaction_*:
    // nothing to render for now.
    default:
      return;
  }
}
