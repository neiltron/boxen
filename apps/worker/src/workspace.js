// Workspace — everything done to a Session's Sandbox, the container where its
// files live. This is the only module that knows a Session has one: the
// names (`sandbox:<id>`, `terminal-<id>`, `p<port>-<id>.localhost`), restore
// and clone, the diff script, the terminal shell, and the preview proxy.
//
//   prepare()                 restore or clone the files; callers share one run
//   env(cwd)                  pi-durable ExecutionEnv for a tool call, with secrets;
//                             the caller prepares first (session.js says how)
//   diff()                    { repo, patch }: the working tree against HEAD
//   probe(previousHead)       the dirty paths with blob ids, HEAD, and the
//                             commits since previousHead (the timeline)
//   terminal(request)         the browser's upgrade, attached to the shell
//   ports(), preview(request, port), checkpoint()
//
// diff and terminal prepare first, and the Session prepares before each env,
// so whichever notices a container that lost its disk gets the files back. The seam is the @cloudflare/sandbox
// object, with two adapters: the SDK's (sessionWorkspace) and an in-memory
// fake (workspace.check.js).
import { getSandbox } from "@cloudflare/sandbox";
import spec from "@boxen/client/openapi.json" with { type: "json" };
import { sandboxEnv, shellQuote } from "./sandbox-env.js";

const ROOT = "/workspace"; // clones run here, so a repo's cwd needn't exist yet

// The working tree against HEAD, untracked files included. A throwaway index
// marks them intent-to-add, so the agent's own index is untouched. Exit 3 or
// 4: no such directory, or not a repo.
const DIFF = (cwd) => [
  `cd ${shellQuote(cwd)} || exit 3`,
  `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4`,
  `idx=$(mktemp); cp "$(git rev-parse --git-dir)/index" "$idx" 2>/dev/null`,
  `GIT_INDEX_FILE=$idx git add -A -N . 2>/dev/null && GIT_INDEX_FILE=$idx git diff HEAD --no-color --no-ext-diff; s=$?; rm -f "$idx"; exit $s`,
].join("\n");

// What is dirty against HEAD and what HEAD is, after a tool call. Each dirty
// path (tracked or untracked, ignored ones excluded) with git's own blob id
// of its content, so a version seen here equals the one a later commit
// tree holds. Then HEAD and its branch, and when HEAD has moved since
// `previous`, each new commit with its tree changes (at most 20). The first
// probe (no previous) only records HEAD: the clone's history is not the
// session's. Lines are tagged F, HEAD, COMMIT, TREE; exit 3 or 4 as DIFF.
// ponytail: one hash-object per dirty path; --stdin-paths if a session keeps hundreds dirty.
const PROBE = (cwd, previous) => [
  `cd ${shellQuote(cwd)} || exit 3`,
  `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4`,
  `git status --porcelain -z --untracked-files=all --no-renames | tr '\\0' '\\n' | while IFS= read -r rec; do`,
  `  p=\${rec:3}; if [ -f "$p" ]; then b=$(git hash-object -- "$p"); else b=-; fi`,
  `  printf 'F\\t%s\\t%s\\t%s\\n' "\${rec:0:2}" "$b" "$p"`,
  `done`,
  `head=$(git rev-parse -q --verify HEAD 2>/dev/null)`,
  `printf 'HEAD\\t%s\\t%s\\n' "$head" "$(git symbolic-ref -q --short HEAD 2>/dev/null)"`,
  `prev=${shellQuote(previous ?? "")}`,
  `if [ -n "$head" ] && [ -n "$prev" ] && [ "$head" != "$prev" ]; then`,
  `  for c in $(git rev-list --max-count=20 "$head" "^$prev" 2>/dev/null || git rev-list --max-count=1 "$head"); do`,
  `    git log -1 --format='COMMIT%x09%H%x09%P%x09%ct%x09%an%x09%s' "$c"`,
  `    git diff-tree -r --root --no-commit-id "$c" | sed 's/^/TREE\\t/'`,
  `  done`,
  `fi`,
].join("\n");

// A Session's workspace in production: its Sandbox cell, the fleet's secrets.
// onProgress(text, level) hears restore and clone lines for the transcript.
export function sessionWorkspace(env, meta, onProgress) {
  return workspace(getSandbox(env.Sandbox, meta.id), meta, {
    secrets: () => env.DIRECTORY.getByName("main").secrets(),
    onProgress,
  });
}

export function workspace(sandbox, meta, { secrets = async () => ({}), onProgress = async () => {} } = {}) {
  const shell = (cwd, values) => sandboxEnv(sandbox, `sandbox:${meta.id}`, cwd, values);
  let preparing = null;

  async function prepare() {
    if ((await sandbox.prepare()) === "restored") await onProgress("restored the workspace from its last checkpoint");
    if (!meta.repo || (await sandbox.exists(`${meta.cwd}/.git`)).exists) return;
    await onProgress(`cloning ${meta.repo}${meta.branch ? ` (${meta.branch})` : ""}…`);
    let output = "";
    const branch = meta.branch ? `--branch ${shellQuote(meta.branch)} ` : "";
    const result = await shell(ROOT, await secrets()).exec(`git clone ${branch}${shellQuote(meta.repo)} ${shellQuote(meta.cwd)}`,
      { onOutput: (text) => { output += text; } });
    if (!result.ok || result.value.exitCode !== 0) {
      const error = output.trim().split("\n").at(-1) || (result.ok ? `exit ${result.value.exitCode}` : result.error.message);
      await onProgress(`workspace setup failed: ${error}`, "error");
      throw new Error(error);
    }
    await onProgress(`cloned into ${meta.cwd}`);
  }

  const self = {
    prepare() {
      preparing ??= prepare().finally(() => { preparing = null; });
      return preparing;
    },

    async env(cwd) {
      return shell(cwd ?? meta.cwd, await secrets());
    },

    async diff() {
      await self.prepare();
      let out = "";
      const r = await shell(meta.cwd).exec(DIFF(meta.cwd), { onOutput: (t) => { out += t; } });
      if (!r.ok) throw r.error;
      if (r.value.exitCode === 4 || r.value.exitCode === 3) return { repo: false, patch: "" };
      if (r.value.exitCode !== 0) throw new Error(out.trim().split("\n").at(-1) || `git diff exited ${r.value.exitCode}`);
      return { repo: true, patch: out };
    },

    // No prepare: the caller's tool call just ran in this container, and a
    // join here could be another event's prepare (session.js, the env option).
    async probe(previousHead) {
      let out = "";
      const r = await shell(meta.cwd).exec(PROBE(meta.cwd, previousHead), { onOutput: (t, _context, info) => { if (info?.stream !== "stderr") out += t; } });
      if (!r.ok) throw r.error;
      if (r.value.exitCode === 4 || r.value.exitCode === 3) return { repo: false };
      if (r.value.exitCode !== 0) throw new Error(`git probe exited ${r.value.exitCode}`);
      const probe = { repo: true, files: [], head: null, branch: null, commits: [] };
      for (const line of out.split("\n")) {
        const [tag, ...rest] = line.split("\t");
        if (tag === "F") probe.files.push({ status: rest[0].trim(), blob: rest[1] === "-" ? null : rest[1], path: rest.slice(2).join("\t") });
        else if (tag === "HEAD") { probe.head = rest[0] || null; probe.branch = rest[1] || null; }
        else if (tag === "COMMIT") probe.commits.push({ sha: rest[0], parents: rest[1] ? rest[1].split(" ") : [], time: Number(rest[2]) * 1000, author: rest[3], subject: rest.slice(4).join("\t"), files: [] });
        else if (tag === "TREE") {
          const m = rest.join("\t").match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) (\w)\t(.*)$/);
          if (m) probe.commits.at(-1)?.files.push({ status: m[2], blob: m[1], path: m[3] });
        }
      }
      return probe;
    },

    // Keep the interactive shell separate from the agent's exec shell. Reuse
    // it on reconnect, but recreate it (with cwd) after the container restarts.
    async terminal(request) {
      await self.prepare();
      const id = `terminal-${meta.id}`;
      try {
        await sandbox.createSession({ id, cwd: meta.cwd });
      } catch (e) {
        if (e.code !== "SESSION_ALREADY_EXISTS" && e.name !== "SessionAlreadyExistsError") throw e;
      }
      // Return this request's upgrade unchanged: celld owns I/O per request.
      return (await sandbox.getSession(id)).terminal(request, { cols: 80, rows: 24, shell: "/bin/bash" });
    },

    ports: () => listeningPorts(sandbox),
    preview: (request, port) => proxyPreview(request, sandbox, port, meta.id),
    checkpoint: () => sandbox.checkpoint(),
  };
  return self;
}

// Keep the app at its origin root: absolute assets, API calls, and HMR all
// arrive on the same host, with no path prefix to strip.
export function previewTarget(host) {
  const match = host.match(/^p(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.localhost(?::\d+)?$/i);
  return match ? { port: Number(match[1]), id: match[2].toLowerCase() } : null;
}

// The rule is the API contract's, which the web app reads too.
export const PREVIEW_PORT = spec.components.schemas.PreviewPort;

export function validPreviewPort(port) {
  return Number.isInteger(port) && port >= PREVIEW_PORT.minimum && port <= PREVIEW_PORT.maximum && port !== PREVIEW_PORT.not.const;
}

// The SDK's containerFetch waits up to 90s for a port that isn't listening,
// then reports the container's state as stale. Check first, from a short
// per-sandbox cache so an app's burst of asset requests costs one exec.
// ponytail: per-isolate cache; a stale "listening" lets one request wait.
const listening = new Map(); // session id → { at, ports }

async function isListening(sandbox, id, port) {
  const hit = listening.get(id);
  if (hit && Date.now() - hit.at < 3000 && hit.ports.includes(port)) return true;
  const ports = await listeningPorts(sandbox);
  listening.set(id, { at: Date.now(), ports });
  return ports.includes(port);
}

async function proxyPreview(request, sandbox, port, id) {
  try {
    if (!await isListening(sandbox, id, port)) {
      return new Response(`Nothing is listening on port ${port} in this sandbox.\nStart the app on 0.0.0.0 and reload.`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    // Return the actual streaming/upgrade Response: celld ties I/O to this
    // request's lifetime. Don't read the body or start a background proxy.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const headers = new Headers(request.headers);
      // Sandbox.fetch only honors wsConnect's target port for a complete
      // upgrade; otherwise it falls back to its control port. Also disallow
      // opting into the SDK's separate, token-based preview router.
      headers.set("connection", "Upgrade");
      headers.delete("x-sandbox-preview-proxy");
      headers.delete("x-sandbox-name");
      return await sandbox.wsConnect(new Request(request, { headers }), port);
    }
    return await sandbox.containerFetch(new Request(request, { redirect: "manual" }), port);
  } catch (e) {
    // On macOS celld reaches only ports the image EXPOSEs (see Dockerfile).
    return new Response(`Preview unavailable on port ${port}: ${e.message}\nStart the app on 0.0.0.0 and reload. ` +
      `On macOS, use an exposed port: 3001 4000 4173 4321 5000 5173 5174 8000 8080 8787 8888.`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}

async function listeningPorts(sandbox) {
  // /proc doesn't depend on ss being installed. bash -c keeps a failing
  // command from exiting the SDK's long-lived shell; tcp6 is optional.
  const result = await sandbox.exec("bash -c 'cat /proc/net/tcp; if [ -r /proc/net/tcp6 ]; then cat /proc/net/tcp6; fi'", { timeout: 5000 });
  if (!result.success) throw new Error(result.stderr || "Could not read listening ports");
  const ports = new Set();
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") continue; // TCP_LISTEN, both IPv4 and IPv6
    const port = parseInt(fields[1].split(":")[1], 16);
    if (validPreviewPort(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
