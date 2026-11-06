// Loads src/index.js in a vm with runtime and agent boundaries stubbed, for
// checks that run without celld. Needs node --experimental-vm-modules.
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import spec from "@boxen/client/openapi.json" with { type: "json" };

const boundaries = {
  "cloudflare:workers": { DurableObject: class {} },
  "@earendil-works/chord/context": { BACKGROUND_CONTEXT: {} },
  "@earendil-works/pi-ai": { Type: {} },
  "@earendil-works/pi-ai/bun-oauth": { registerBunOAuthFlows() {} },
  "@earendil-works/pi-ai/models": { getSupportedThinkingLevels: () => ["off"] },
  "@earendil-works/pi-ai/providers/all": { builtinModels() {} },
  "@earendil-works/pi-durable": {
    SessionFailed: class extends Error {}, createRegistry() {}, defineExtension: (x) => x, defineTool() {}, Harness: {}, hook() {}, section() {}, ToolTask: {}, watchEvents() {},
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage: {} },
  "@earendil-works/pi-durable/tools": { CodingTools: {} },
  "@boxen/client/openapi.json": { default: spec }, // the real one
  "./artifacts.js": { ARTIFACT_KINDS: [], Artifacts: class {} },
  "./sandbox.js": { Sandbox: class {} },
  "./cell-sqlite.js": { CellSqlite: class {} },
  "./credentials.js": { directoryCredentials() {} },
  "./sandbox-env.js": { sandboxEnv() {}, shellQuote() {} },
};

export async function load(stubs, globals = {}) {
  stubs = { ...boundaries, ...stubs };
  const context = createContext({ Request, Response, URL, atob, console, ...globals });
  const modules = new Map();
  async function link(name) {
    if (modules.has(name)) return modules.get(name);
    const exports = stubs[name];
    const module = exports
      ? new SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context })
      : new SourceTextModule(await readFile(new URL(`src/${name}`, import.meta.url), "utf8"), { context });
    modules.set(name, module);
    await module.link(link);
    return module;
  }
  const entry = await link("index.js");
  await entry.evaluate();
  return entry.namespace;
}
