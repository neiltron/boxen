# boxen

boxen is a web app you host yourself for running [pi](https://github.com/earendil-works/pi)
coding agents. Each Session is one agent with its own Linux container. You
open it in a browser, give it a repo if you want, and send it prompts.

- The agent runs on the server, not in your browser. Closing the tab doesn't
  stop it, and after a server restart the Session resumes its run on its own.
- Every browser open on a Session sees the same transcript as it streams,
  including thinking and tool calls.
- Each Session has a container with `/workspace`, cloned from your repo if
  you gave one. After each run boxen copies `/workspace` to its object store,
  and a new container gets it back. Running processes don't come back.
- The side panel has five views. Artifacts shows documents the agent writes
  with its `artifact` tool, such as markdown, HTML, SVG, mermaid and code.
  Changes shows the diff in `/workspace`. Preview shows a web app running in
  the container. Terminal is a shell in the container. Events shows the raw
  agent events.
- The agent can use any model provider pi supports. You add an API key or
  sign in to the provider from the Providers sheet.
- The `boxen` command and an MCP server can list, create and prompt Sessions,
  so scripts and other agents such as Claude Code can use boxen too.

boxen has no accounts yet. Anyone who can reach it can use every Session,
terminal and stored credential. Run it with local access or on your tailnet,
and never open it to the internet. [Better Auth feasibility](docs/better-auth.md)
covers the plan for accounts.

## Install

You need an x86-64 Linux machine with systemd, running Omarchy, Arch, Ubuntu
22.04 or later, or Debian 12 or later. An Ubuntu EC2 VM works. Give it at
least 8 GiB of RAM and 40 GiB of disk. It doesn't need a GPU.

```sh
git clone https://github.com/neiltron/boxen.git
cd boxen
./install.sh --access tailscale   # HTTPS on your tailnet only
# or
./install.sh --access local       # http://localhost:8093 on this machine only
```

The installer prints its plan and asks for sudo before it changes anything.
It installs Docker if the machine doesn't have it, downloads its own copies
of Node and celld, and runs the RustFS object store in Docker. Then it builds
and deploys the app and starts two systemd services, `boxen` and
`boxen-storage`. If Tailscale still needs you to log in, the installer
finishes a local install and prints the command that switches it to
Tailscale.

After it finishes:

1. Open the URL the installer printed.
2. Open Providers at the bottom of the sidebar. Add a model API key or sign
   in to a provider. GitHub and Linear tokens go there too.
3. Press + in the sidebar. Enter a git repo URL if you want one cloned, press
   Create, and send a prompt.

To upgrade, pull the checkout and run `./install.sh` again. The installer
keeps your Sessions and credentials. If the upgrade restarts celld, each
container loses any files changed since its last run.

[Installation](docs/installation.md) has the rest. It covers installs run by
scripts or agents, the `boxenctl` commands for doctor, logs, stop and
uninstall, networking, and current limits. For example, Preview from another
machine needs an SSH tunnel.

### Cloudflare

boxen is written as a Cloudflare Workers app, with Durable Objects and
`@cloudflare/sandbox` containers. It runs on [celld](https://github.com/denoland/celld),
which implements those APIs on your own machine. There are no instructions
or tests for deploying it to Cloudflare yet.

## Docs

| Doc | Contents |
|---|---|
| [Installation](docs/installation.md) | Install options, `boxenctl`, networking, storage, limits |
| [Using boxen](docs/using.md) | Rename and archive, Preview, Terminal |
| [Scripts and agents](docs/automation.md) | The `boxen` command, the MCP server, running a turn from Node |
| [How boxen works](docs/architecture.md) | The cells, the agent loop, containers, the repo layout |
| [Session protocol](docs/session-protocol.md) | The messages on a Session's WebSocket |
| [Development](docs/development.md) | Running from a checkout, checks, the API contract |
| [Releases](docs/releases.md) | Versions, pinned dependencies, upgrades |
| [Changelog](CHANGELOG.md) | Changes in each release |
