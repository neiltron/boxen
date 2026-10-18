# Changelog

## 0.1.0-rc.3 — unreleased

Pi runtime upgrade candidate. Not yet published or production-certified.

- Pin pi-durable, pi-ai, and Chord **1.0.0 → 1.3.0** together. Retain celld **0.6.2**, Sandbox SDK/image **0.12.9**, Node **24.5.0**, pnpm **12.9.1**, and existing native/container pins. Lockfile changes are confined to the new runtime dependency graph.
- Add bounded Sandbox binary readers, upstream UTF-8 line scanning, literal argv execution, and stdout/stderr labels. Readers retain the opened file across renames and replacement. Directory readers and watches remain explicitly unsupported. Keep SDK process handles inside the Sandbox cell, and consume command event streams in the caller rather than forwarding output callback RPCs.
- Return artifact tool data in `output`; transcript messages still use `content`. Nonzero bash exits now produce the upstream error result and `exit_code` diagnostic.
- Recover through typed `SessionFailed` errors and `harness.closed`. Stop subscribers and wait for the old Harness to close before reopening. Preserve workspace preparation through self-RPC.
- Fix **#102** in the shared client: interleaved status notes no longer discard assistant deltas or prevent message settlement.
- Stop takes effect while a tool runs. The prompt handler now holds its cell event until the run is idle: the run's I/O belongs to that event, and once it had returned, the abort's commit refused the run's reply commit at celld's input gate and failed the Harness, leaving the tool spinning with no result. The shared client also settles a tool call its aborted or failed answer never answered, live and from a snapshot. The hold ends after four minutes, under celld's 300s handler budget: a handler killed at the budget takes the run's I/O with it and the turn stalls, so a longer turn goes on unheld and Stop during it has the old hazard. The sandbox process itself still runs to completion (#86).
- Add real Harness/CellSqlite tests, a generated 1.0.0 store fixture, and isolated live SDK reader/argv checks. No subagents, code mode, or application rename.

### Upgrade and compatibility

Active `pi.tool` tasks migrate from version 1 to version 2. Tests cover retained history, a safe pending tool, queued input, request deduplication, storage failure, pending waiters, and reopen. They do **not** certify a host upgrade or replay of unsafe tools. Keep `supportedUpgradeFrom` empty and state/API generations at **1**.

Quiesce work, verify workspace checkpoints, and take an off-machine storage backup before upgrading. **Do not downgrade a mutated store to pi-durable 1.0.0.** Restore the pre-upgrade storage and matching workspace checkpoints instead; old source alone is not rollback. See [release notes and manual gates](docs/releases.md). Real provider turns, hot adoption, node restart recovery, and terminal/preview still require live validation. Stop during a running bash was validated on an isolated celld 0.6.2 node; it ends the turn at once but does not kill the command (#86).

## 0.1.0-rc.2 — unreleased

Celld-only upgrade candidate. Not yet a published or production-certified release.

- Upgrade celld **0.6.1 → 0.6.2**. Pin the Linux x86-64 archive by SHA-256, verified against the upstream release asset digest.
- Regenerate installer runtime constants, the default source tag, package versions, and development binary references from the release inputs.
- Retain pi-durable/pi-ai/chord **1.0.0**, Sandbox SDK/image **0.12.9**, Node **24.5.0**, pnpm **12.9.1**, and all existing container digests. The dependency lockfile is unchanged.
- Exercise replacement of the baseline celld 0.6.1 binary in the installer tests, including checksum/version failure and persisted restart intent. Reject development deploys through that old binary.

### Upstream changes

[celld 0.6.2](https://github.com/denoland/celld/releases/tag/v0.6.2) fixes a deploy deadlock, WAL-header recovery after a crash, and compaction after a failed or abandoned eviction. It also corrects forwarded fetch failures, adds cancellation for fetches to loaded Workers, and fixes facet WebSockets. These are upstream changes, not evidence that the application's open transport or cancellation issues are resolved.

### Upgrade and compatibility

No application state migration or API change is introduced. State/API generations remain **1**; no application upgrade or downgrade path is certified (`supportedUpgradeFrom` remains empty).

Upstream permits rolling upgrades from celld 0.6.1. Our single-node installer still replaces and restarts celld. Before installation, stop new turns, let active work finish, verify successful workspace checkpoints, and take an off-machine storage backup. Use this candidate's installer, not the previously installed manager. A runtime restart destroys live sandbox disks; changes after the last checkpoint can be lost. Retained source does not make downgrade safe.

Keep the self-RPC workspace preparation path unchanged. Before publication, complete the [release checklist](docs/releases.md), including a real model turn, hot adoption, runtime-replacement retry, transcript/workspace recovery, terminal and preview. In particular, recheck **#83**, **#84**, **#86**, **#100**, and **#102**. The isolated deployment smoke does not cover those cases. The pi-durable upgrade and subagents remain separate work.

## 0.1.0-rc.1 — unreleased

First versioned application candidate; not yet a published or production-certified release.

- Establish one application version for worker, UI, CLI, MCP server and internal client.
- Retain celld **0.6.1**, pi-durable/pi-ai/chord **1.0.0**, Sandbox SDK **0.12.9**, Node **24.5.0**, pnpm **12.9.1** and the existing RustFS digest.
- Make critical direct library pins exact and pin the Sandbox base image by digest.
- Generate/check standalone installer runtime pins and release metadata from shared inputs.
- Add CI checks, isolated deployment smoke, tagged source packaging and draft release creation.
- Detect installed runtime mismatches and persist required restarts across retries.
- Check development runtime versions and fail deploys on errors instead of reporting false success.
- Reject application/runtime source mismatches in the installer; expose local CLI version with `pds --version`.

### Compatibility

No application state migration is introduced. No upgrade/downgrade path is certified yet; complete the release checklist before claiming one. Runtime changes can restart celld and lose sandbox changes after the latest successful checkpoint. This is a source distribution, not a byte-reproducible prebuilt container release.
