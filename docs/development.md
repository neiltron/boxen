# Development

This guide covers running, testing, and iterating on boxen from a local Git checkout. To install and run boxen on a Linux server instead, see [installation.md](installation.md).

The local dev scripts (`start.sh`, `stop.sh`, `deploy.sh`) work on both macOS (using `caffeinate` when available) and Linux.

## Prerequisites

| Requirement | Details |
| --- | --- |
| **Node.js** | `>=24.5.0 <25` (enforced by `package.json` `engines`; `ops/runtime.json` pins `24.5.0`). |
| **pnpm** | `package.json` pins `pnpm@12.9.1` (enable via `corepack enable` or install pnpm v10+/12). |
| **Docker daemon** | Running locally for per-session Sandbox containers (e.g. OrbStack via `orbctl start` on macOS, or Docker Engine on Linux). |
| **RustFS** | `rustfs` binary on `PATH` or at `~/.local/bin/rustfs`. Used as local S3-compatible storage on `:9000` with data stored in `../.rustfs-data` beside the checkout. |
| **Pinned `celld`** | `celld-0.6.2` on `PATH` or at `~/.local/bin/celld-0.6.2` (or set `BOXEN_CELLD` to a `0.6.2` binary). `ops/celld.mjs` enforces the exact version pinned in `ops/runtime.json`. |
| **shellcheck** | Required by `pnpm run check:ops` (`brew install shellcheck`, `apt install shellcheck`, or `pacman -S shellcheck`). |

### Installing the pinned `celld` binary

Download the `v0.6.2` archive for your platform from the [`denoland/celld` v0.6.2 release](https://github.com/denoland/celld/releases/tag/v0.6.2) (the Linux x86-64 URL and SHA-256 are pinned in `ops/runtime.json`), decompress it, and place the executable at `~/.local/bin/celld-0.6.2`:

```sh
# Example (macOS Apple Silicon — substitute celld-x86_64-unknown-linux-gnu.gz on x86-64 Linux):
mkdir -p ~/.local/bin
curl -fsSL https://github.com/denoland/celld/releases/download/v0.6.2/celld-aarch64-apple-darwin.gz \
  | gunzip > ~/.local/bin/celld-0.6.2
chmod +x ~/.local/bin/celld-0.6.2
~/.local/bin/celld-0.6.2 --version
```

## Running Locally from a Checkout

1. **Install workspace dependencies:**

   ```sh
   pnpm install
   ```

2. **Start local storage and the `celld` node:**

   ```sh
   ./start.sh
   ```

   `start.sh` checks that `node`, Docker, `rustfs`, and `celld-0.6.2` are available, then starts:
   - **RustFS** on `http://127.0.0.1:9000` (data in `../.rustfs-data`, logs in `../.rustfs.log`)
   - **`celld-0.6.2`** on `http://127.0.0.1:8093` under a restart supervisor (logs in `.celld.log`)

   If a gitignored `.env` file exists in the repository root, `start.sh` loads `GH_TOKEN` and/or `LINEAR_API_KEY` into the running node via `POST /api/secrets`. Only keys present in `.env` are sent, so tokens already configured in the UI are preserved.

3. **Deploy the worker and Sandbox image to local RustFS:**

   ```sh
   pnpm run deploy
   ```

   > **Important:** Write `pnpm run deploy`, **not** `pnpm deploy` (which is a built-in pnpm command).

   `pnpm run deploy` runs `@boxen/worker`'s `deploy` script (`ops/celld.mjs deploy . --bucket s3://pid-cells --endpoint http://127.0.0.1:9000`), which bundles the worker and builds/pushes the Sandbox container image into the local RustFS bucket. Because it pushes to `127.0.0.1:9000`, RustFS must be running first (`./start.sh`). On a brand-new checkout with `.env` tokens, re-run `./start.sh` once after this initial deploy so the worker receives them.

4. **Start the web UI dev server:**

   ```sh
   pnpm ui
   ```

   Opens Vite at `http://localhost:5176` with `/api` and WebSocket traffic proxied to `http://127.0.0.1:8093`, plus local OAuth callback listeners (`1455`, `1456`, `53692`). Sign in to a model provider from the sidebar. To build a production UI bundle into `apps/ui/dist`, run `pnpm build`.

### Hot-deploying worker changes and stopping

- **After editing `apps/worker/src/`**, run `./deploy.sh`. Running `celld-0.6.2` nodes adopt the new version on their next pointer poll (~15 seconds) without restarting, so Sandbox containers keep their disks and in-flight sign-ins survive. If adoption stalls, check `.celld.log` or restart with `./stop.sh && ./start.sh`.
- **To stop `celld`** (leaving RustFS running for faster restarts): `./stop.sh`
- **To stop both `celld` and RustFS**: `./stop.sh rustfs`

## Running Checks & Tests

Install Playwright's Chromium browser once per machine before running the UI checks:

```sh
pnpm --dir apps/ui exec playwright install --with-deps chromium
```

Run the full workspace verification suite:

```sh
pnpm check
```

`pnpm check` runs the following checks in order:

| Target | Command | What it verifies |
| --- | --- | --- |
| Release pins | `pnpm run check:release` | `ops/release.mjs check` (verifies generated runtime pins across `package.json`, `ops/boxenctl.ts`, `install.sh`, `apps/worker/Dockerfile`, `start.sh`, `stop.sh`, package versions, and lockfile pins) and `ops/release.test.mjs`. |
| Ops & installer | `pnpm run check:ops` | `ops/boxenctl.test.ts`, `tsc -p ops`, and `shellcheck install.sh`. |
| `@boxen/client` | `pnpm --filter @boxen/client run check` | `session.check.ts`, `openapi-typescript --check` (generated types match `openapi.json`), and `tsc` (`tsconfig.json` and `tsconfig.core.json`). |
| `@boxen/worker` | `pnpm --filter @boxen/worker run check` | `metadata`, `assets`, `workspace`, `contract`, `protocol`, `turn-env`, `sandbox-env`, `harness`, and `stranded` checks using real in-memory SQLite with mocked runtime/agent boundaries. |
| `@boxen/cli` | `pnpm --filter @boxen/cli run check` | `cli.check.ts` and `tsc`. |
| `@boxen/mcp` | `pnpm --filter @boxen/mcp run check` | `mcp.check.ts` and `tsc`. |
| `@boxen/ui` | `pnpm --filter @boxen/ui run check` | `oxlint`, Playwright workspace tests, `tsc -b && vite build`, and built-app Chromium smoke tests (`session-actions.check.mjs`: two-viewer sync, rename failure, archive/undo/restore, draft preservation, keyboard controls, and narrow-screen menus). |

You can run any individual package check with `pnpm --filter <package> run check` (for example, `pnpm --filter @boxen/worker run check`).

> Note: Offline worker and UI checks mock runtime/HTTP/WS boundaries and do not replace a live `celld`/deployment smoke test.

## API Contract & Reference (`openapi.json`)

`packages/client/openapi.json` is the single REST contract for boxen. It defines every HTTP endpoint the worker serves along with shared constants (sandbox token names, artifact kinds, and the Preview port rule):

- The worker routes directly from `openapi.json`, so an endpoint must be declared in the spec to be served.
- The web app, CLI, and MCP server call the API only through `@boxen/client`.
- After editing `packages/client/openapi.json`, regenerate client types:

  ```sh
  pnpm --filter @boxen/client run generate
  ```

- `apps/worker/contract.check.mjs` exercises every operation through `@boxen/client`, validates each response against the spec, and fails if the worker and spec disagree on any route or method.

### Building the HTML API reference

```sh
pnpm reference
```

Generates [docs/api-reference.html](api-reference.html) using `@redocly/cli`. The output is git-ignored and built on demand (rebuild after spec changes). The HTML is prerendered so it reads cleanly offline, and loads Redoc's script from `cdn.redocly.com` for search and collapsible sections.

Session WebSocket messages are outside OpenAPI and documented in [docs/session-protocol.md](session-protocol.md), which the generated reference links to.

## Manual Smoke Checks

### Preview checks

- **Offline check** (in `apps/worker/`):
  ```sh
  node workspace.check.js
  ```
  Covers proxy/port rules without starting a container.
- **Live stack checklist** (after deploying the worker and starting the UI):
  - [ ] Load a dev server in Preview and verify absolute asset requests succeed in the browser Network tab.
  - [ ] Edit a source file in the sandbox and confirm HMR updates live through the preview proxy.
  - [ ] Switch sessions and reload the UI to confirm the selected preview port is recalled.
  - [ ] Request port `3000` and port `65536` directly on the preview host and confirm both return HTTP `400`.

### Terminal checks

- **Offline checks** (in `apps/worker/`):
  ```sh
  node workspace.check.js
  node --experimental-vm-modules assets.check.mjs
  ```
  Verify shell logic (in-memory sandbox) and routing; they do not exercise `celld`'s WebSocket upgrade transport or the container PTY.
- **Live stack checklist** (after deploying the worker and starting the UI):
  - [ ] Open Terminal in a repo session and check `pwd`, typing, paste, Unicode, ANSI colors, and `Ctrl-C`. Repeat in a session without a repo.
  - [ ] Run `stty size`; resize, dock, hide/show, and switch tabs. Confirm the initial render is not blank and full-screen programs adapt to the new dimensions.
  - [ ] Switch light/dark themes and reconnect; confirm the shell's working directory and variables survive. Disconnect and reconnect the network and verify the connection status updates.
  - [ ] Run `exit`, then click **Reconnect**. Send the agent a bash task to confirm its exec shell still works independently. Switch sessions and confirm terminal output does not leak across sessions.
