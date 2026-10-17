# Changelog

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
