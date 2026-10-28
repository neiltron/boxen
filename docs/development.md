# Development

## Run it from a checkout

For working on boxen itself; to use it, [install it](installation.md) instead.
The scripts are written for macOS (`caffeinate`, OrbStack). They need a Docker
daemon (`orbctl start`), `rustfs` on your PATH, and the pinned celld **0.6.2**
at `~/.local/bin/celld-0.6.2`. RustFS keeps its data in `../.rustfs-data`,
beside the checkout.

```sh
pnpm install && pnpm run deploy  # bundles the worker, saves the sandbox image to the bucket
./start.sh                       # rustfs (:9000) + celld (:8093) + .env tokens
pnpm ui                          # http://localhost:5176
```

Write `pnpm run deploy`, not `pnpm deploy`: that is a built-in pnpm command.
`pnpm build` builds the UI into `apps/ui/dist`.

After editing `apps/worker/src/`, run `./deploy.sh`. 0.6.2 nodes pick up a new version
in about 15 seconds without a restart, so sandboxes keep their disks.

## Checks

Node 22+. `pnpm check` runs every check in the workspace: the
installer's tests, type-check and `shellcheck install.sh` (install shellcheck
first; the check fails without it), then each package's `check` script (`apps/worker/`: the metadata,
assets, workspace and contract checks; `packages/client/`: generated types
current, type-check; `apps/ui/`: session client, lint, Playwright, build,
built-app smoke).

```sh
pnpm install
pnpm --dir apps/ui exec playwright install --with-deps chromium  # once per machine
pnpm check
pnpm --filter @boxen/worker run check  # or one package
```

`packages/client/openapi.json` is the REST contract: every endpoint the worker
serves, and the constants the web app shares with it (sandbox token names,
artifact kinds, the Preview port rule). The worker routes from it, so an
endpoint must be in the spec to be served, and the web app calls the API only
through the client. After editing it, run `pnpm --filter
@boxen/client run generate` to regenerate the client's types.
`apps/worker/contract.check.mjs` drives every operation through the client,
checks each response against the spec, and fails when the worker and the spec
disagree on a route or a method.

**API reference.** `pnpm reference` builds the REST reference from
`openapi.json` into [docs/api-reference.html](api-reference.html); open that
file in a browser (the link works once it is built).
It is built on demand and git-ignored, not committed, so no generated HTML
lands in diffs and there is nothing to keep current: rebuild it after a spec
change. Redocly CLI (`@redocly/cli`, one bundled package) renders it. The
page holds the whole reference prerendered, and loads Redoc's script from
cdn.redocly.com for search and the collapsible parts; offline it still reads.
The Session WebSocket's messages are not in the spec:
[docs/session-protocol.md](session-protocol.md), beside the reference,
describes them, and the reference links to it.

The backend check uses real in-memory SQLite with mocked runtime/agent
boundaries. The Chromium smoke check serves the built UI and mocks HTTP/WS;
it checks two-viewer updates, rename failure, archive/undo/restore, draft
preservation, keyboard controls, and narrow-screen menus.
Neither replaces a live celld/deployment smoke test.

## Preview checks

Run `node workspace.check.js` in `apps/worker/` for proxy/port checks without a container. On a
running stack, also check absolute assets in the Network tab, edit a source
file to confirm HMR, and switch sessions/reload the UI to check port recall.
Try port 3000 and 65536 directly in the preview host: both should return 400.

## Terminal checks

Browser smoke test (after deploying the worker and starting the UI):

1. Open Terminal in a repo session; check `pwd`, typing, paste, Unicode,
   ANSI colors, and Ctrl-C. Try a session without a repo too.
2. Run `stty size`; resize, dock, hide/show, and switch tabs. Check that the
   first render isn't blank and a full-screen program fits the new size.
3. Switch light/dark themes and reconnect; check that the shell's cwd and
   variables survive. Disconnect/reconnect the network and watch the status.
4. Run `exit`, then use Reconnect. Send the agent a bash task to confirm its
   shell still works. Switch sessions and check that output doesn't leak.

Offline checks, in `apps/worker/`: `node workspace.check.js` (the shell, with an
in-memory sandbox) and `node --experimental-vm-modules assets.check.mjs` (the route).
They do not test celld's upgrade transport or the container's PTY
implementation.

