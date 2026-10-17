// Linux process/filesystem seam for adapter tests. No SDK, celld or Docker.
// This does not certify the SDK's transport or cancellation behavior.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

export function localSandbox(cwd) {
  const running = new Set();
  const processes = new Map();
  const stats = { maxReply: 0 };
  const launch = (command, options = {}) => {
    const child = spawn("bash", ["-c", command], { cwd: options.cwd ?? cwd, env: { ...process.env, ...options.env }, signal: options.signal });
    running.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; options.onOutput?.("stdout", b.toString()); });
    child.stderr.on("data", (b) => { stderr += b; options.onOutput?.("stderr", b.toString()); });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => { running.delete(child); stats.maxReply = Math.max(stats.maxReply, Buffer.byteLength(stdout)); resolve({ exitCode, stdout, stderr }); });
    });
    done.catch(() => {});
    return { child, done, logs: () => ({ stdout, stderr }) };
  };
  return {
    stats,
    async exec(command, options) { return launch(command, options).done; },
    async execWithOutput(command, options) { return launch(command, options).done; },
    async startReaderProcess(command) {
      const p = launch(command);
      const id = String(p.child.pid);
      processes.set(id, p);
      return id;
    },
    async getProcessLogs(id) { return processes.get(id).logs(); },
    async killProcess(id) {
      const p = processes.get(id);
      if (!p) return;
      p.child.kill();
      await p.done;
      processes.delete(id);
    },
    async readFile(path, options) { return { content: await fs.readFile(path, options?.encoding ?? "utf8") }; },
    async writeFile(path, content, options) { await fs.writeFile(path, content, options?.encoding ?? "utf8"); },
    async exists(path) { return { exists: await fs.stat(path).then(() => true, () => false) }; },
    async mkdir(path, options) { await fs.mkdir(path, options); },
    async close() { for (const child of running) child.kill(); },
  };
}
