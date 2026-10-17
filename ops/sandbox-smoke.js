// Test-only worker entry. ops/smoke.ts copies this into its isolated deployment;
// the application's wrangler.jsonc never points here. No production test route.
export * from "./src/index.js";
import worker from "./src/index.js";
import { getSandbox } from "@cloudflare/sandbox";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { sandboxEnv } from "./src/sandbox-env.js";

export default {
  async fetch(request, bindings, execution) {
    if (new URL(request.url).pathname !== "/__smoke/sandbox") return worker.fetch(request, bindings, execution);
    const sandbox = getSandbox(bindings.Sandbox, "runtime-smoke");
    const env = sandboxEnv(sandbox, "runtime-smoke", "/workspace");
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    try {
      getOrThrow(await env.writeFile("/workspace/read.txt", "first\nsecond", ctx));
      const reader = getOrThrow(await env.openBinaryReader("/workspace/read.txt", undefined, ctx));
      getOrThrow(await env.exec("mv /workspace/read.txt /workspace/old.txt; printf replacement > /workspace/read.txt", undefined, ctx));
      check(new TextDecoder().decode(getOrThrow(await reader.read(0, 5, ctx))) === "first", "reader lost original file");
      check(getOrThrow(await reader.scanLines({ startLine: 1 }, ctx)).selectedBytes === 6, "line scan failed");
      await reader.close(ctx);
      check((await env.openBinaryReader("/workspace/missing.txt", undefined, ctx)).error?.code === "not_found", "missing-file error changed");
      const result = await createReadTool().execute({ path: "/workspace/old.txt", offset: 2, limit: 1 }, { env }, ctx);
      check(result.output[0]?.text === "second", "1.3 read tool failed");
      let stdout = "", stderr = "";
      const command = getOrThrow(await env.exec(["node", "-e", "process.stdout.write(process.argv[1]);process.stderr.write('err')", "$HOME; 'literal'"], {
        onOutput: (text, _context, info) => { if (info.stream === "stdout") stdout += text; else stderr += text; },
      }, ctx));
      check(command.exitCode === 0 && stdout === "$HOME; 'literal'" && stderr === "err", `argv or stream labels failed: ${JSON.stringify({ command, stdout, stderr })}`);
      return Response.json({ ok: true });
    } catch (e) {
      console.error("sandbox runtime smoke failed", e);
      return Response.json({ error: String(e?.stack ?? e) }, { status: 500 });
    } finally {
      await env.cleanup(ctx);
      await sandbox.destroy();
    }
  },
};
