// Sandbox — the per-session container, and the persistence of its files.
// A container's disk dies with it: idle sleep, a node restart, a Docker
// restart. So /workspace is checkpointed to the bucket at quiet points, and
// prepare() restores the newest checkpoint into a fresh container before
// anything uses it.
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { SANDBOX_EXEC_URL } from "./sandbox-events.js";

const DIR = "/workspace";
// Outside DIR on purpose: it marks this container, not the files, as prepared.
const PREPARED = "/tmp/.pds-prepared";
// Replaced checkpoints are deleted, so the current one must never expire.
const TTL = 10 * 365 * 24 * 3600;

export class Sandbox extends BaseSandbox {
  // Internal capability call only. The public worker/router does not forward
  // requests to this host; previews keep their original URL and use other paths.
  // Native fetch can transport a body stream across celld isolates; an ordinary
  // execStream RPC or an output callback cannot. Preserve SDK fetch otherwise.
  async fetch(request) {
    if (request.method === "POST" && request.url === SANDBOX_EXEC_URL) {
      try {
        const { command, options } = await request.json();
        return new Response(await this.execStream(command, options), { headers: { "content-type": "text/event-stream" } });
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    return super.fetch(request);
  }

  // celld cannot return the SDK's Process object across isolates: its methods
  // are RPC stubs. Keep it here and expose only the ID. Reader callers use the
  // existing getProcessLogs/killProcess methods, whose results are plain data.
  async startReaderProcess(command) {
    return (await this.startProcess(command)).id;
  }

  // Returns "restored" when this call brought the files back, else "ready".
  // Concurrent callers share one restore.
  prepare() {
    this.preparing ??= this.#prepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  async #prepare() {
    if ((await this.exists(PREPARED)).exists) return "ready";
    const backup = await this.ctx.storage.get("backup");
    if (backup) await this.restoreBackup(backup);
    await this.writeFile(PREPARED, "");
    return backup ? "restored" : "ready";
  }

  // Snapshots DIR and keeps only the newest. Call it when nothing is writing:
  // files mid-write may be captured torn.
  async checkpoint() {
    // A stopped container has nothing new; an unprepared one would replace
    // the checkpoint with an empty disk.
    if (!this.ctx.container?.running || !(await this.exists(PREPARED)).exists) return null;
    const old = await this.ctx.storage.get("backup");
    // ponytail: only node_modules is skipped; other build output (.venv, target/) is backed up too.
    const backup = await this.createBackup({ dir: DIR, localBucket: true, ttl: TTL, excludes: ["node_modules"] });
    await this.ctx.storage.put("backup", backup);
    if (old) await this.env.BACKUP_BUCKET.delete([`backups/${old.id}/data.sqsh`, `backups/${old.id}/meta.json`]);
    return backup;
  }

  // Idle sleep stops the container and drops its disk, so checkpoint first:
  // the terminal can change files after the agent's last checkpoint.
  async onActivityExpired() {
    try { await this.checkpoint(); } catch (e) { console.error("checkpoint before sleep failed", e); }
    return super.onActivityExpired();
  }
}
