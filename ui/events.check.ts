// Self-check for the reducer: node events.check.ts
import assert from "node:assert/strict";
import { applyEvent, emptyModel } from "./src/lib/events.ts";

const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
const m = emptyModel();
// Late join mid-run: one finished turn in the transcript, a tool still running.
applyEvent(m, {
  type: "snapshot",
  run: { inputs: [1] },
  entries: [
    { model: [{ role: "user", content: "hi" }] },
    { model: [{ role: "assistant", content: [{ type: "text", text: "Listing." }, call], stopReason: "toolUse" }] },
  ],
  tools: [{ callId: "c1", name: "bash", status: "running", output: "a\n" }],
});
assert.equal(m.running, true);
assert.deepEqual(m.items.map((i) => i.kind), ["user", "assistant"]);
const tool = () => (m.items[1] as any).blocks[1];
assert.equal(tool().state, "running");
assert.equal(tool().output, "a\n");

applyEvent(m, { type: "tool_execution_update", toolCallId: "c1", output: { trimStart: 1, append: "b\n" } });
assert.equal(tool().output, "\nb\n");
applyEvent(m, { type: "tool_execution_end", toolCallId: "c1", entry: { model: [{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a\nb\n" }] }] } });
assert.equal(tool().state, "done");
assert.equal(tool().output, "a\nb\n");

// A steer while running, then a streamed answer that ends in an error.
applyEvent(m, { type: "message_start", message: { role: "user", content: "faster" } });
assert.equal((m.items[2] as any).steer, true);
applyEvent(m, { type: "message_start", message: { role: "assistant", content: [] } });
applyEvent(m, { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Do" }] });
applyEvent(m, { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "ne" }] });
assert.equal((m.items[3] as any).blocks[0].text, "Done");
applyEvent(m, { type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "error", errorMessage: "boom" }] } });
applyEvent(m, { type: "run_end" });
assert.equal(m.running, false);
assert.deepEqual(m.items.at(-1), { kind: "system", level: "error", text: "boom", seq: 4 });
console.log("events.check ok");
