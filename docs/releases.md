# Application releases

A release versions **pi-durable-sessions as a tested stack**, independently of celld's version. Worker, UI, CLI, MCP server and internal client share one version. Nothing is published to npm yet.

The current candidate is **0.1.0-rc.2**, upgrading celld to **0.6.2** while retaining pi-durable/pi-ai/chord **1.0.0**. The initial **0.1.0-rc.1** baseline used celld 0.6.1. A version in package.json is not evidence of publication or completed validation. Check [GitHub Releases](https://github.com/neiltron/celld-test/releases) for published releases.

## Sources of truth

| File | Owns |
|---|---|
| `package.json` | Application version and exact pnpm version |
| `apps/worker/package.json` | Exact direct pins for pi-durable, pi-ai, chord, Sandbox SDK |
| `pnpm-lock.yaml` | Full resolved dependency graph and package integrity hashes |
| `ops/runtime.json` | celld/Node versions, download URLs and SHA-256; RustFS, probe and Sandbox base image digests |
| `ops/compatibility.json` | State/API generations, supported upgrade paths and rollback caveats |
| `CHANGELOG.md` | Human-readable changes and migration notes |

`node ops/release.mjs sync` generates runtime constants in the standalone installer, its bootstrap pins/default ref, workspace package versions, dev start/stop binary references and Dockerfile base image. `check` detects drift; it does not modify files. The release tool uses YAML only during development/CI; the host manager remains Node-standard-library-only, per ADR-0001.

Use Node from `ops/runtime.json` and the package manager in package.json:

```sh
cd pi-durable-sessions
pnpm install --frozen-lockfile
pnpm run check:release
node ops/release.mjs manifest
```

The manifest includes exact dependency versions/integrities, runtime pins, Git commit, application version, lockfile SHA-256, compatibility declarations, and dirty-checkout status. It is diagnostic on a development checkout. Only `pack` creates release artifacts, and it refuses dirty checkouts or a tag not pointing to HEAD.

## Version policy

Tags are `pi-durable-sessions/v<VERSION>`, e.g. `pi-durable-sessions/v0.1.0-rc.2`.

- `0.x.y` patch: compatible fixes, including compatible dependency updates.
- `0.x.0` minor: features or breaking changes; explicitly document any breaking behavior.
- `-rc.N`: a candidate, not a production-readiness claim.
- State and API generations change only when their compatibility contract changes. They are declarations, not a migration implementation.
- Never move a published tag or replace published assets. Correct mistakes with a new version. Configure repository rules to restrict release-tag creation and forbid updates/deletion; this is a repository-admin action, not configured by this checkout.

## Prepare a candidate

1. Make one intentional dependency/runtime change per PR where practical. Keep runtime upgrades separate from release-tooling changes.
2. Edit the app version, relevant pins and changelog. Update `ops/compatibility.json` with actual tested upgrade paths; an empty list means none are certified.
3. Update the lockfile using pinned pnpm, without opportunistically updating unrelated packages. Sandbox SDK and image tag must match; resolve and review the image digest too.
4. Run `node ops/release.mjs sync`, then `pnpm install --frozen-lockfile` and `pnpm check`. Commit generated files alongside their inputs.
5. Run the isolated live smoke with the exact pinned celld binary:
   ```sh
   node ops/smoke.ts --celld /path/to/celld-0.6.2
   ```
6. Review/merge the candidate. From its clean commit, create and push the version tag **when ready to create a release draft**:
   ```sh
   git tag -a pi-durable-sessions/v0.1.0-rc.2 -m 'pi-durable-sessions 0.1.0-rc.2'
   git push origin pi-durable-sessions/v0.1.0-rc.2
   ```

CI installs frozen dependencies, runs the checks, and runs isolated RustFS/celld deployment smoke. Tag builds package the source and create a **draft** GitHub release. RC tags also receive the prerelease flag. No automatic production deployment occurs. A rerun does not overwrite an existing draft; inspect it explicitly rather than silently replacing assets.

## Manual publication gate

Before publishing a draft, record the candidate commit, tested platform, results and upgrade/rollback notes in its release notes:

- [ ] Fresh install on a supported Linux x86-64 systemd host; configure a provider and stream a real agent turn.
- [ ] Sandbox bash/read/write/edit and repository clone work.
- [ ] Terminal attach/reconnect and preview HTTP/WebSocket paths work on the tested platform.
- [ ] Hot-deploy during a live session; verify new behavior is adopted and old in-flight work finishes correctly.
- [ ] Quiesce work, create a successful checkpoint, restart celld, and verify transcript and workspace recovery.
- [ ] Upgrade from each declared supported application version, including required runtime replacement/restart and retry after a failed attempt.
- [ ] Verify backup/restore and state clearly whether downgrade is supported. Do not equate retained source directories with safe rollback.
- [ ] Verify release artifact checksums, version/tag/commit and migration notes.

The automated smoke tests deployment, UI HTML/JS, API and storage—not model execution, PTY transport, upgrade adoption, host services, Tailscale, or workspace recovery. Do not publish a stable release based only on that smoke. The first RC can be published for testing with incomplete checks explicitly disclosed; it must not claim certified upgrade paths.

## Artifacts and installation

`node ops/release.mjs pack` produces `dist/release/` containing:

- `pi-durable-sessions-<version>.tar.gz`: source from the tagged commit, not the working directory;
- `install.sh`: bootstrap from that same commit;
- `release.json`: stack metadata and archive/installer checksums;
- `SHA256SUMS`: archive, installer and manifest hashes.

For a published release, download all artifacts from its GitHub release page, then:

```sh
sha256sum --check SHA256SUMS
# Substitute the downloaded version. Inspect the installer before executing it.
tar -xzf pi-durable-sessions-0.1.0-rc.2.tar.gz
cd pi-durable-sessions
./install.sh --access tailscale
```

Checksums detect corruption; they are not independent signatures. Trust in publication still depends on the repository/release account. Signed attestations and fully prebuilt distribution are follow-ups.

A standalone remote installer defaults to **its own version tag**, not a moving branch. Until that tag exists, use a checkout or an explicit `PIDS_REF` pointing to a reviewed commit. `PIDS_REF` remains a development escape hatch; branches are not immutable releases. Prefer the checked source artifact above for release installs. For upgrades, run the **new release's installer**, not an older installed manager against newer source. The manager rejects a source/application/runtime pin mismatch before making changes.

The installer compares installed celld/Node versions and replaces mismatches using verified downloads. It records restart intent before replacement, so retrying cannot leave an old process unnoticed merely because its on-disk binary now matches. `pds --version` reports the local CLI application version, without contacting a server. `pids inspect --json` reports the application version, desired runtime and whether installed executables match the manager's pins; it does **not** prove which worker version a running node has adopted.

Application-only changes normally hot-adopt. Runtime upgrades can restart celld and destroy live sandbox disks. Stop new turns, verify checkpoints and back up persistent storage off-machine before upgrading. Review upstream rolling/full-stop requirements; this installer does not orchestrate multi-node fleet migrations or automatically undo state changes.

## Limits of this first iteration

This is a **source release**. The installer still builds UI/worker/container artifacts on the host. The Sandbox base is digest-pinned, but `apt-get` in its Dockerfile resolves packages at build time, and host Docker/Tailscale/distro tools are not immutable. The manifest explicitly does not claim a byte-reproducible container build.

Next steps: publish and deploy the exact built sandbox/UI/worker artifacts, attach provenance, expose actual running app/worker version, automate the manual transport/recovery cases, and implement validated migration/rollback operations. Those are separate from selecting and recording an exact dependency stack today.
