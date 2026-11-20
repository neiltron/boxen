# Releases

A release versions **boxen as a tested stack**, independently of `celld` or upstream libraries. The worker, UI, CLI, MCP server, and internal client share one application version. Nothing is published to npm yet.

The current candidate is **`0.1.0-rc.3`**, which upgrades `pi-durable`, `pi-ai`, and `chord` to **1.3.0** while retaining `celld` **0.6.2** from `0.1.0-rc.2` (the initial `0.1.0-rc.1` baseline used `celld` **0.6.1**). A version in `package.json` is not proof of publication or completed validation—check [GitHub Releases](https://github.com/neiltron/boxen/releases) for published releases. See [ADR-0002](adr/0002-application-releases-pin-a-tested-stack.md) for the release architecture.

## Sources of truth

| File | Owns |
|---|---|
| `package.json` | Application version and exact `pnpm` version (`packageManager`) |
| `apps/worker/package.json` | Exact direct pins for `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, and `@cloudflare/sandbox` |
| `pnpm-lock.yaml` | Full resolved dependency graph and package integrity hashes |
| `ops/runtime.json` | `celld` and Node versions, download URLs, and SHA-256 checksums; RustFS, probe, and Sandbox base image digests |
| `ops/compatibility.json` | State/API generations, supported upgrade paths, restart policy, and rollback caveats |
| `CHANGELOG.md` | Human-readable changes and migration notes |

## Release tooling (`ops/release.mjs`)

| Command | Purpose |
|---|---|
| `node ops/release.mjs sync` | Propagates pins from `package.json` and `ops/runtime.json` to `ops/boxenctl.ts`, `install.sh` (bootstrap pins and default `BOXEN_REF`), workspace `package.json` versions, root `engines.node`, `apps/worker/Dockerfile`, and `start.sh`/`stop.sh` `celld` references |
| `node ops/release.mjs check` | Verifies zero drift in generated files, exact critical dependency pins, lockfile integrity and `pnpm` pin, and Sandbox SDK/image version parity (read-only; also run via `pnpm run check:release`) |
| `node ops/release.mjs manifest` | Prints JSON release metadata (exact dependency versions/integrities, runtime pins, Git commit, version, lockfile SHA-256, compatibility declarations, dirty-checkout status) |
| `node ops/release.mjs pack` | Packages `dist/release/` from the tagged `HEAD` commit; refuses dirty checkouts or tags not pointing to `HEAD` |

Run release verification using the Node version from `ops/runtime.json` and the `pnpm` version in `package.json`:

```sh
cd boxen
pnpm install --frozen-lockfile
pnpm run check:release
node ops/release.mjs manifest
```

`ops/release.mjs` uses the `yaml` package during development and CI; the host manager (`ops/boxenctl.ts`) remains Node-standard-library-only per [ADR-0001](adr/0001-installer-stays-standalone.md).

## Version policy

Release Git tags use the format `v<VERSION>` (for example, `v0.1.0-rc.3`).

- **`0.x.y` (patch)**: Compatible fixes, including compatible dependency updates.
- **`0.x.0` (minor)**: New features or breaking changes (document breaking behavior explicitly in [CHANGELOG.md](../CHANGELOG.md)).
- **`-rc.N`**: Release candidate; not a production-readiness claim.
- **State and API generations**: Change `stateGeneration` or `apiGeneration` in `ops/compatibility.json` only when their compatibility contract changes. They are declarations, not an automated migration mechanism.
- **Immutable tags and assets**: Never move a published tag or replace published release assets—ship a new version to correct mistakes. Restrict release-tag creation and forbid updates/deletions through GitHub repository rulesets (a repository-admin action outside this checkout).

## Preparing a release candidate

1. **Scope the change**: Keep one intentional dependency or runtime change per PR where practical, and separate runtime upgrades from release-tooling changes.
2. **Update inputs**: Edit the version in `package.json`, relevant pins in `apps/worker/package.json` and `ops/runtime.json`, `CHANGELOG.md`, and `ops/compatibility.json`. List only tested upgrade paths in `supportedUpgradeFrom`—an empty array means none are certified.
3. **Update the lockfile**: Run pinned `pnpm` without opportunistically upgrading unrelated packages. Keep the `@cloudflare/sandbox` SDK version and `sandboxImage` tag identical, and resolve/review the image digest.
4. **Sync and run checks**:
   ```sh
   node ops/release.mjs sync
   pnpm install --frozen-lockfile
   pnpm check
   ```
   Commit generated files alongside their inputs.
5. **Run the isolated live smoke test** with the exact pinned `celld` binary:
   ```sh
   node ops/smoke.ts --celld /path/to/celld-0.6.2
   ```
6. **Tag the merged commit** when ready to create a release draft:
   ```sh
   git tag -a v0.1.0-rc.3 -m 'boxen 0.1.0-rc.3'
   git push origin v0.1.0-rc.3
   ```

**CI behavior:** CI installs frozen dependencies, runs all checks and the isolated RustFS/`celld` smoke test, packages the tagged commit, and creates a **draft** GitHub release (marking `-rc.N` tags as prereleases). No automatic deployment occurs, and reruns do not overwrite an existing draft—inspect drafts explicitly before publishing.

## Manual publication checklist

Before publishing a draft release, record the candidate commit, tested platform, results, and upgrade/rollback notes in the GitHub release notes:

- [ ] Fresh install on a supported Linux x86-64 systemd host; configure a provider and stream a real agent turn.
- [ ] Sandbox `bash`/`read`/`write`/`edit` tools and repository clone work.
- [ ] Terminal attach/reconnect and Preview HTTP/WebSocket paths work on the tested platform.
- [ ] Hot-deploy during a live session; verify new behavior is adopted and in-flight work finishes cleanly.
- [ ] Quiesce work, create a successful workspace checkpoint, restart `celld`, and verify transcript and workspace recovery.
- [ ] Upgrade from each version declared in `supportedUpgradeFrom`, including required runtime replacement/restart and retry after a failed attempt.
- [ ] Verify backup/restore and state clearly whether downgrade is supported (do not equate retained source directories with safe rollback).
- [ ] Verify release artifact checksums, version/tag/commit, and migration notes.

> [!IMPORTANT]
> **Automated smoke test limits:** `ops/smoke.ts` exercises deployment, UI HTML/JS assets, API, API 404 handling, storage, and the real Sandbox SDK reader/argv/stream-label path (using a temporary smoke-only worker entry). It does **not** test model execution, PTY transport, upgrade adoption, host services, Tailscale, or workspace recovery. Do not publish a stable release based solely on automated smoke. Early RCs may be published for testing with incomplete checks explicitly disclosed, provided they do not claim certified upgrade paths.

## Release artifacts and verification

`node ops/release.mjs pack` writes `dist/release/`:

| Artifact | Contents |
|---|---|
| `boxen-<version>.tar.gz` | Clean `git archive` of the tagged commit under `boxen/` (never working-tree files) |
| `install.sh` | Bootstrap installer from the same commit |
| `release.json` | Release manifest plus archive and installer SHA-256 checksums |
| `SHA256SUMS` | SHA-256 checksums for the archive, `install.sh`, and `release.json` |

### Installing from a published release

Download all artifacts from the [GitHub Release](https://github.com/neiltron/boxen/releases) page, verify checksums, inspect the installer, and run it:

```sh
sha256sum --check SHA256SUMS
# Substitute the downloaded version and inspect install.sh before running it:
tar -xzf boxen-0.1.0-rc.3.tar.gz
cd boxen
./install.sh --access tailscale
```

`SHA256SUMS` detects download corruption; it is not an independent cryptographic signature. Trust in publication still depends on the repository and release account. Signed attestations and prebuilt distribution are planned follow-ups.

### Remote installs, upgrades, and version reporting

- **Default ref**: A standalone `install.sh` defaults `BOXEN_REF` to its own version tag (not a moving branch). Prefer the verified source archive above for release installs; `BOXEN_REF` is a development escape hatch for reviewed commits.
- **Upgrades**: Always run the **new release's installer** rather than an older installed `boxenctl` against newer source. `boxenctl` rejects source/application/runtime pin mismatches before making changes. See [Installation and operations](installation.md) for the full upgrade procedure.
- **Runtime replacement**: Setup compares installed `celld` and Node versions, replaces mismatches using checksum-verified downloads, and persists restart intent before replacement so retries cannot miss a required restart.
- **Version checks**: `boxen --version` prints the local CLI application version without contacting a server. `boxenctl inspect --json` reports the installed application version, desired runtime, and whether binaries on disk match the manager's pins—it does **not** prove which worker bundle a running `celld` node has adopted.
- **Downtime & state safety**: Application-only deploys normally hot-adopt, while runtime upgrades restart `celld` and destroy live sandbox disks. Quiesce turns, verify workspace checkpoints, and take an off-machine storage backup before upgrading. The installer does not orchestrate multi-node rollouts or undo state migrations.

## Current candidate notes (`0.1.0-rc.3`)

### Storage migration and downgrade restriction

- `pi-durable` `1.3.0` migrates active `pi.tool` tasks from version 1 to version 2. Automated tests cover a checked-in `1.0.0` SQLite fixture (history, a safe in-flight tool, and queued input) using the existing `CellSqlite` facade with no table prefix. This is a bounded migration test, not host-upgrade certification.
- **Do not downgrade a mutated store to `pi-durable` `1.0.0`.** Keep a pre-upgrade, off-machine storage backup and matching workspace checkpoints. Restoring old application source alone is not rollback. `supportedUpgradeFrom` remains empty and state/API generations remain `1`.
- Stop new turns and quiesce existing work before upgrading. The test's safe replay tool does not prove that an interrupted `bash`, `write`, or artifact operation can be replayed safely.

### Sandbox adapter behavior and limits

- **File reading**: Sandbox reads hold an open file descriptor in a short-lived container helper. Unix-socket replies are bounded to 256 KiB of file data. Line scanning uses the upstream UTF-8 scanner with bounded memory, transferring the file in chunks (large-file scans can be slow). Closing releases the helper; abandoned helpers expire after two idle minutes. Container loss or helper expiry returns an error rather than reading from a replacement path.
- **Unsupported operations**: Directory paging and filesystem watching explicitly return `not_supported`. Output spill files are not implemented, and the adapter does not claim full upstream environment conformance.
- **Command streams**: Command events use an internal native-fetch stream because `celld` cannot transfer streams or forwarded callbacks over standard RPC; this adds no public API route. Sandbox SDK `0.12.9` terminates final partial output lines in its HTTP command stream, and the adapter preserves those events rather than stripping whitespace.
- **Stopping running commands**: Stopping a turn while a command runs ends the turn immediately—the prompt handler holds its cell event for the run so an abort does not collide with the run's reply commit at `celld`'s input gate—while the underlying command continues running in the container until it exits (#86).
- **Disabled features**: Subagents and code mode are not enabled (their upstream packages may still appear as transitive dependencies).

## Current limitations and next steps

This is a **source release**: the installer still builds the UI, worker, and sandbox container on the host. Although the Sandbox base image is digest-pinned, `apt-get` in `apps/worker/Dockerfile` resolves packages at build time, and host Docker, Tailscale, and distro tools are not immutable (`reproducibleContainerBuild: false` in `release.json`).

Planned follow-ups:
- Publish and deploy prebuilt sandbox, UI, and worker artifacts with signed provenance.
- Expose the actual running worker/application version from `celld`.
- Automate live transport and restart-recovery checks.
- Implement validated state migration and rollback operations.
