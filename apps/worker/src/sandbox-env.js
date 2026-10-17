// pi-durable ExecutionEnv over a Cloudflare Sandbox (a per-session Linux
// container that celld supervises). Only what the built-in read/write/edit/bash
// tools call is implemented; the rest of FileSystem answers "not_supported".
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { openSandboxReader } from "./sandbox-reader.js";

const ok = (value) => ({ ok: true, value });
const err = (error) => ({ ok: false, error });

function fileError(e, path) {
  const text = `${e?.code ?? ""} ${e?.message ?? e}`;
  const code = /not.?found|ENOENT/i.test(text) ? "not_found"
    : /is.?a.?directory|EISDIR/i.test(text) ? "is_directory"
    : /permission|EACCES/i.test(text) ? "permission_denied"
    : "unknown";
  return err(new FileError(code, String(e?.message ?? e), path));
}

function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/") || ".";
}

const resolve = (cwd, path) => normalize(path.startsWith("/") ? path : `${cwd}/${path}`);

export const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// Per-command env for the session's tokens: nothing is written into the
// container. GitHub HTTPS URLs pick up GH_TOKEN through a one-off git config.
export function secretEnv(secrets) {
  const env = { ...secrets };
  if (secrets.GH_TOKEN) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.https://x-access-token:${secrets.GH_TOKEN}@github.com/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
    });
  }
  return env;
}

export function sandboxEnv(sandbox, id, cwd, secrets = {}) {
  const readers = new Set();
  const unsupported = (name) => async () => err(new FileError("not_supported", `${name} is not available in the sandbox`));
  const env = {
    id,
    cwd,
    async absolutePath(path) { return ok(resolve(env.cwd, path)); },
    async joinPath(parts) { return ok(normalize(parts.join("/"))); },
    // ponytail: no symlink resolution; edits through two spellings of one file can race.
    async canonicalPath(path) { return ok(resolve(env.cwd, path)); },

    async readTextFile(path) {
      try { return ok((await sandbox.readFile(path)).content); } catch (e) { return fileError(e, path); }
    },
    async readBinaryFile(path) {
      try {
        const { content } = await sandbox.readFile(path, { encoding: "base64" });
        return ok(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
      } catch (e) { return fileError(e, path); }
    },
    async openBinaryReader(path, options, context) {
      const result = await openSandboxReader(sandbox, resolve(env.cwd, path), options, context);
      if (result.ok) {
        const reader = result.value;
        const close = reader.close;
        reader.close = async () => { await close(); readers.delete(reader); };
        readers.add(reader);
      }
      return result;
    },
    async writeFile(path, content) {
      try {
        await sandbox.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
        if (typeof content === "string") await sandbox.writeFile(path, content);
        else {
          let binary = "";
          for (let at = 0; at < content.length; at += 8192) binary += String.fromCharCode(...content.subarray(at, at + 8192));
          await sandbox.writeFile(path, btoa(binary), { encoding: "base64" });
        }
        return ok(undefined);
      } catch (e) { return fileError(e, path); }
    },
    async exists(path) {
      try { return ok((await sandbox.exists(path)).exists); } catch (e) { return fileError(e, path); }
    },
    async fileInfo(path) {
      const r = await sandbox.exec(`stat -c '%F\t%s\t%Y' -- ${shellQuote(path)}`);
      if (r.exitCode !== 0) return fileError(new Error(r.stderr), path);
      const [type, size, mtime] = r.stdout.trim().split("\t");
      const kind = type.includes("directory") ? "directory" : type.includes("link") ? "symlink" : "file";
      return ok({ name: path.slice(path.lastIndexOf("/") + 1), path, kind, size: Number(size), mtimeMs: Number(mtime) * 1000 });
    },
    async createDir(path, options) {
      try { await sandbox.mkdir(path, options); return ok(undefined); } catch (e) { return fileError(e, path); }
    },
    openTextLineReader: unsupported("openTextLineReader"),
    readTextLines: unsupported("readTextLines"),
    appendFile: unsupported("appendFile"),
    truncateFile: unsupported("truncateFile"),
    flushFile: unsupported("flushFile"),
    renameFile: unsupported("renameFile"),
    listDir: unsupported("listDir"),
    openDirReader: unsupported("openDirReader"),
    watch: unsupported("watch"),
    remove: unsupported("remove"),
    createTempDir: unsupported("createTempDir"),
    createTempFile: unsupported("createTempFile"),

    // ponytail: no output spill file; the Harness already keeps the tail the model sees.
    async exec(command, options = {}, context) {
      try {
        // The SDK runs commands in one long-lived shell per sandbox, where an
        // `exit` would kill it; a fresh bash per command, as the Node env does.
        if (context?.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
        if (Array.isArray(command)) {
          if (!command.length || command.some((s) => typeof s !== "string" || s.includes("\0"))) return err(new ExecutionError("spawn_error", "Invalid argv"));
          command = `exec -- ${command.map(shellQuote).join(" ")}`;
        }
        let script = `bash -c ${shellQuote(command)}`;
        if (options.inheritEnv === false) {
          const vars = Object.entries(options.env ?? {}).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
          script = `env -i -- ${vars} ${script}`;
        }
        const exec = options.onOutput ? sandbox.execWithOutput.bind(sandbox) : sandbox.exec.bind(sandbox);
        const r = await exec(script, {
          cwd: options.cwd ?? env.cwd,
          env: { ...secretEnv(secrets), ...options.env },
          timeout: options.timeout === undefined ? undefined : options.timeout * 1000,
          stream: options.onOutput !== undefined,
          onOutput: (stream, data) => options.onOutput?.(data, context, { stream }),
          signal: context?.abortSignal,
        });
        return ok({ exitCode: r.exitCode });
      } catch (e) {
        if (context?.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
        return err(new ExecutionError(/timeout/i.test(e?.message) ? "timeout" : "unknown", String(e?.message ?? e)));
      }
    },
    async cleanup() { await Promise.all([...readers].map((reader) => reader.close())); },
  };
  return env;
}
