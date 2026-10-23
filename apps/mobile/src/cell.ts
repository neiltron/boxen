// The phone's own Session cell: a pi-durable Harness that speaks the Session
// WebSocket protocol (packages/client/src/protocol.ts), so the shared session
// client and the web app's ChatView drive it exactly as they drive a Session
// cell. The commands follow apps/worker/src/session.js, without the sandbox,
// the Directory, or titles. The worker (agent.worker.ts) gives it storage and
// models; cell.check.ts gives it memory and a faux model.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry, defineExtension, Harness, section, watchEvents,
  type Conversation, type Extension, type Storage,
} from "@earendil-works/pi-durable";
import type { Session, SessionCommand, SessionFrame } from "@boxen/client";

export interface Agent { harness: Harness; root: Conversation; models: MutableModels }

export const LOCAL_META: Session = { id: "local", name: "On this phone", cwd: "/", createdAt: 0 };

const Phone = defineExtension({
  name: "phone",
  sections: [section("preamble", () =>
    "You are pi, an assistant running on the user's phone. Be concise: answers are read on a small screen.", { tag: false })],
});

export async function openAgent(storage: Storage, models: MutableModels, extensions: Extension[] = []): Promise<Agent> {
  const registry = createRegistry();
  for (const extension of [Phone, ...extensions]) registry.install(extension);
  // steeringMode "all": as session.js, every queued prompt joins at the next boundary.
  const harness = await Harness.open(storage, { models, registry, settings: { steeringMode: "all" } }, ctx);
  const root = await harness.root(ctx);
  // As session.js's withdrawLeftovers: prompts a failed run left queued are withdrawn, not stranded.
  const { submissions } = await harness.inspect(ctx);
  if (!submissions.some((s) => s.status === "placed")) {
    for (const { id, type } of submissions) if (type === "input") await harness.abortSubmission(id, ctx);
  }
  harness.resume(); // the run the page was closed in continues
  return { harness, root, models };
}

type Handlers = { [K in SessionCommand["type"]]: (cmd: Extract<SessionCommand, { type: K }>) => unknown };

// One server per agent; connect() is one socket's worth of it, and
// broadcast() sends a frame to every socket (an error line that isn't the
// transcript's, as a refused command's is).
export function serve(agent: Promise<Agent>) {
  let stopping = 0; // aborts whose run has not ended yet
  const sockets = new Set<(frame: SessionFrame) => void>();

  const connect = (send: (frame: SessionFrame) => void) => {
    let stream: Awaited<ReturnType<typeof watchEvents>> | null = null;
    let closed = false;
    sockets.add(send);

    const commands: Handlers = {
      async sub() {
        const { harness, root } = await agent;
        const joined = await watchEvents(harness, root.id, ctx);
        if (closed) return void joined.stop();
        stream = joined;
        send({ type: "meta", meta: LOCAL_META });
        send({ type: "events", events: [joined.snapshot] });
        send({ type: "ready" });
        joined.start(async (events) => send({ type: "events", events: [...events] }));
      },
      ping() {},
      async prompt(cmd) {
        const refused = (e: Error): never => { throw Object.assign(new Error(e.message, { cause: e }), { requestId: cmd.requestId }); };
        const { root } = await agent.catch(refused);
        const submission = await root.submit({ type: "input", content: cmd.message, whenBusy: "steer", requestId: cmd.requestId }, ctx).catch(refused);
        if (stopping) await submission.abort(ctx); // queued behind a run being stopped: stops with it
      },
      steer(cmd) { return commands.prompt({ ...cmd, type: "prompt" }); },
      async abort() {
        stopping++;
        try { await (await agent).root.abort(ctx); } finally { stopping--; }
      },
      async configure(cmd) {
        // The level is the client's pick from this cell's own models list.
        await (await agent).root.configure({ model: cmd.model, thinkingLevel: cmd.thinkingLevel as ModelThinkingLevel | undefined }, ctx);
      },
      async models() {
        const { models } = await agent;
        const list = (await models.getAvailable()).map((m) => ({
          provider: m.provider, id: m.id, name: m.name, thinkingLevels: getSupportedThinkingLevels(m),
        }));
        send({ type: "models", models: list });
      },
      rename() { throw new Error("the conversation on this phone can't be renamed"); },
    };

    return {
      message(raw: string) {
        let cmd: SessionCommand;
        try { cmd = JSON.parse(raw); } catch { return; }
        const type = typeof cmd?.type === "string" && Object.hasOwn(commands, cmd.type) ? cmd.type : null;
        if (!type) return;
        Promise.resolve()
          .then(() => (commands[type] as (c: SessionCommand) => unknown)(cmd))
          .catch((e: Error & { requestId?: string }) => send({ type: "error", error: e.message, requestId: e.requestId }));
      },
      close() {
        closed = true;
        sockets.delete(send);
        stream?.stop();
      },
    };
  };

  const broadcast = (frame: SessionFrame) => { for (const send of sockets) send(frame); };
  return Object.assign(connect, { broadcast });
}
