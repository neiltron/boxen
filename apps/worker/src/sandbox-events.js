// Consume the SDK's JSON SSE command stream in the caller's isolate. Passing
// output callbacks through the Sandbox cell would forward RPC capabilities,
// which celld does not support across that boundary.
export async function* sandboxEvents(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data = [];
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("Command aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("Command aborted");
      buffer += done ? decoder.decode() + "\n\n" : decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line === "" && data.length) {
          const text = data.join("\n");
          data = [];
          if (text.trim() && text !== "[DONE]") yield JSON.parse(text);
        }
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
