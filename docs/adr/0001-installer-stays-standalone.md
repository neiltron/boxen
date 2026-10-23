# The boxen installer stays standalone

The Linux installer (`install.sh` and `ops/boxenctl.ts`) must run on a host before the system, or any operations CLI for it, is installed. So it stays a separate, self-contained program: Node standard library only, one file copied to the host, no imports from the rest of the app. A future operations CLI (start, stop, deploy, status) is a different program and does not absorb the installer, even though the two restate some runtime settings.

## Consequences

- Some knowledge is written twice on purpose: `install.sh` checks host support in bash before Node exists, and `validateHost` in `ops/boxenctl.ts` checks it again.
- Architecture reviews should not propose merging the installer into the operations CLI or having it import shared app modules. Sharing settings between them needs a mechanism that works before install, such as a plain data file the installer carries.
