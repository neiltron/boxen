# boxen

boxen is a self-hosted web app for running [pi](https://github.com/earendil-works/pi)
coding agents. Each Session is an agent with its own Linux sandbox. You can
give it a repo, then watch it work from any browser.

- **It keeps working when you leave.** Close the tab and the agent carries on.
  The run picks up again after a restart, even with no browser open.
- **Share a Session live.** Any number of tabs or people can follow the same
  Session as it streams text, thinking and tool calls.
- **Each Session gets its own sandbox.** A Linux container with `/workspace`,
  started from your repo if you give one. Files are checkpointed after each
  run and restored into a fresh container. Running processes are not restored.
- **See what it made.** The side panel shows Artifacts the agent writes
  (markdown, HTML, SVG, mermaid, code), a Changes diff, a Preview of an app
  running in the sandbox, and a Terminal into the sandbox.
- **Use any model provider pi supports,** with an API key or the provider's
  own sign-in.
- **Drive it from other tools.** The `boxen` command line and an MCP server
  let scripts and other agents (Claude Code, for example) create Sessions and
  prompt them.

> **No accounts yet.** Anyone who can reach a boxen can use every Session,
> terminal and stored credential. Keep it on your machine or your tailnet, and
> never expose it to the internet. Accounts are a follow-up; see
> [Better Auth feasibility](docs/better-auth.md).

## Install

On an x86-64 Linux machine with systemd: Omarchy/Arch, Ubuntu 22.04+ or
Debian 12+, including an Ubuntu EC2 VM. Plan on 8 GiB of RAM and 40 GiB of
disk. No GPU is needed.

```sh
git clone https://github.com/neiltron/boxen.git
cd boxen
./install.sh --access tailscale   # private HTTPS on your tailnet
# or
./install.sh --access local       # http://localhost:8093, this machine only
```

The installer asks for sudo and shows its plan before it changes anything.
It installs Docker if it's missing, plus a private Node and celld, and runs
RustFS (the object store) in Docker. It then builds and deploys the app and
registers two systemd services, `boxen` and `boxen-storage`. If Tailscale
still needs a login, the installer leaves a working local install and prints
the step to finish.

Then:

1. Open the URL the installer printed.
2. Under **Providers**, at the bottom of the sidebar, add a model API key or
   sign in to a provider. GitHub and Linear tokens go there too.
3. Press **+** in the sidebar, enter a git repo to clone if you want one,
   press **Create**, and send a prompt.

To upgrade, update the checkout and run `./install.sh` again. Sessions and
credentials are kept, but restarting the sandbox runtime loses any files not
yet checkpointed. [Installation](docs/installation.md) covers unattended and
agent-driven installs, `boxenctl` management (doctor, logs, stop, uninstall),
networking, and the known limits, such as previews needing an SSH tunnel from
another machine.

### Hosted on Cloudflare

The app is a Workers app (Durable Objects and `@cloudflare/sandbox`). Today
it runs on [celld](https://github.com/denoland/celld) on your own machine. A
Cloudflare deployment isn't set up or tested yet.

## Docs

| | |
|---|---|
| [Installation](docs/installation.md) | Install options, management, networking, storage, limits |
| [Using boxen](docs/using.md) | Rename and archive, Preview, Terminal |
| [Scripts and agents](docs/automation.md) | The `boxen` CLI, the MCP server, running a turn from Node |
| [How boxen works](docs/architecture.md) | Cells, the Harness, sandboxes, the repo layout |
| [Session protocol](docs/session-protocol.md) | The Session WebSocket's messages |
| [Development](docs/development.md) | Running from a checkout, checks, the API contract |
| [Releases](docs/releases.md) · [Changelog](CHANGELOG.md) | Versioning, the pinned stack, upgrades |
