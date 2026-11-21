# Inbox

A second interface on boxen, built only on `@boxen/client`: GitHub issues and same-repo PRs on one side, the Sessions working on them on the other. Run it next to the main UI; both read the same Directory feed, so a Session started here shows up in boxen's sidebar at once, and its progress shows up here.

```sh
pnpm inbox   # http://localhost:5177, proxied to the node on :8093 like `pnpm ui`
```

Enter one or more repos (`owner/name`, comma-separated) and optionally a label. Both live in the address, so bookmark `?repos=neiltron/boxen&label=ready-for-agent`.

- **To do:** open issues with no Session. Pick folders on the repo map to scope the agent, edit the brief, and **Start session**. The Session is named `#<number> <title>`; that name is how the inbox links it back to the issue, so renaming it in boxen unlinks it.
- **PR reviews:** use the **All / Issues / PRs** filter (saved in the address as `kind`). Draft PRs have a gray indicator; ready PRs have a green one. **Start review** creates a Session on the PR's head branch with a brief to review against its base branch, report findings, and not push. The description is labelled as the author's text. Re-review by replying in the linked Session. Fork PRs are excluded; “do not push” is a prompt instruction, not a sandbox permission restriction.
- **Running / Needs you:** the Session's status from the Directory. The strip shows the last hour (your messages, tool calls, and how long it has waited on you); the map shades the folders its `write`/`edit` calls touched. Reply or steer from the panel.

Issues and the repo's file list come through the worker (`/api/github/issues`, `/api/github/files`) with the fleet's `GH_TOKEN`.
