# `@boxen/ui`

The web application for boxen: a React and TypeScript interface providing the Session sidebar, provider settings, live streaming chat transcript, and a dockable Trellis workspace (Artifacts, Changes, Preview, Terminal, and Events).

For user-facing workspace controls and keyboard shortcuts, see [Using boxen — Workspace layout and keyboard shortcuts](../../docs/using.md#workspace-layout-and-keyboard-shortcuts).

## Local development

Run these commands from the repository root after `pnpm install`:

```sh
pnpm ui                            # Start the Vite dev server on http://localhost:5176
pnpm build                         # Type-check (tsc -b) and build the production bundle
pnpm --filter @boxen/ui run check  # Run lint, workspace tests, build, and session smoke checks
```

## Checks and tests

On a fresh machine, install the Chromium browser Playwright uses once:

```sh
pnpm --dir apps/ui exec playwright install --with-deps chromium
```

`pnpm --filter @boxen/ui run check` (or `pnpm run check` inside `apps/ui/`, and `pnpm check` at the workspace root) runs four steps in order:

| Script | What it runs |
| --- | --- |
| `pnpm --filter @boxen/ui run lint` | Oxlint static checks across `apps/ui/` |
| `pnpm --filter @boxen/ui run test:workspace` | Playwright suite against a real Trellis workspace in an isolated Vite fixture (no `celld` backend required). Covers entering from the session list, panel cycling and composer focus, macOS key codes, nested hide/restore, horizontal/vertical layouts, partial hiding, dialogs/IME, and listener teardown/rebinding. |
| `pnpm --filter @boxen/ui run build` | TypeScript project build (`tsc -b`) and Vite production bundle |
| `pnpm --filter @boxen/ui run check:sessions` | Built-app smoke test backed by HTTP and WebSocket fixtures. Covers entering from the real session list, panel hide/show, and keeping a newly opened mobile panel visible across composer rerenders. |
