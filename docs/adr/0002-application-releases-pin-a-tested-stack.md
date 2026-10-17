# Application releases pin a tested stack

Status: accepted.

## Decision

Version pi-durable-sessions independently of its runtime dependencies. Worker, UI, CLI, MCP server and internal client share one application version, with namespaced Git tags `pi-durable-sessions/v<VERSION>`. Other prototypes remain outside this release train.

An application release identifies a Git commit, frozen dependency graph, exact critical library versions, checksum-pinned native runtimes, digest-pinned container bases and explicit compatibility notes. Generate release metadata from package manifests, the lockfile and `ops/runtime.json`; do not maintain a second handwritten npm dependency inventory.

The first distribution is a source archive plus metadata and checksums. CI creates draft releases after checks and isolated runtime smoke; a maintainer reviews the remaining live validation checklist before publication. Never infer safe rollback from the availability of old source artifacts.

## Consequences

- Runtime upgrades are reviewed application changes, not automatic tracking of upstream latest.
- `ops/runtime.json` generates embedded installer constants and bootstrap pins. CI rejects drift. This preserves ADR-0001: the installed manager stays standalone and needs no application imports or third-party libraries.
- Remote release installs default to the installer's version tag. Explicit refs remain a development escape hatch. Tags/assets must not be replaced after publication.
- Source releases do not yet guarantee identical container builds: Dockerfile distro packages are resolved at build time. Fully prebuilt artifact distribution and signed provenance remain follow-ups.
- Actual running-worker identity and state migration/rollback need dedicated operational support; installed binary versions alone do not prove deployment adoption.

See `pi-durable-sessions/docs/releases.md` for release operations and validation requirements.
