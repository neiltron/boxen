// Sandbox — the per-session container, and the persistence of its files.
// A container's disk dies with it: idle sleep, a node restart, a Docker
// restart. So /workspace is checkpointed to the bucket at quiet points, and
// prepare() restores the newest checkpoint into a fresh container before
// anything uses it.
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

const DIR = "/workspace";
// Outside DIR on purpose: it marks this container, not the files, as prepared.
const PREPARED = "/tmp/.pds-prepared";
// Replaced checkpoints are deleted, so the current one must never expire.
const TTL = 10 * 365 * 24 * 3600;

export class Sandbox extends BaseSandbox {
  // celld cannot return the SDK's Process object across isolates: its methods
  // are RPC stubs. Keep it here and expose only the ID. Reader callers use the
  // existing getProcessLogs/killProcess methods, whose results are plain data.
  async startReaderProcess(command) {
    return (await this.startProcess(command)).id;
  }

  // The SDK invokes onOutput without awaiting it. Across a cell boundary it
  // returns an RPC promise, so exec can finish before the caller sees output.
  // Preserve order and drain those calls before returning the command result.
  async execWithOutput(command, options) {
    let pending = Promise.resolve();
    try {
      return await this.exec(command, { ...options, onOutput: (stream, data) => {
        pending = pending.then(() => options.onOutput(stream, data));
        pending.catch(() => {}); // observed again by the awaited drain below
      } });
    } finally {
      await pending;
    }
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
