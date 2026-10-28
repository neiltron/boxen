# Using boxen

## Rename and archive

Use the **⋯** menu in a sidebar row or the session header to rename or archive
it. Names are trimmed, limited to 120 characters, and shared with every viewer;
a manual rename wins over an automatic title that is still being generated.

**Archive is organization, not shutdown.** It hides a session from the Active
list for everyone without stopping its agent, deleting files, or making the
conversation read-only. Agent activity does not unarchive it. Switch the sidebar
to **Archived** to find it again, then **Restore** (or use **Undo** immediately
after archiving). Archiving the open session keeps its view and unsent draft;
its header shows **Archived · Restore**.

`PATCH /api/session/:id` accepts `{ "name": "New title" }` and/or
`{ "archived": true }` (`false` restores). Metadata changes neither open the
Harness nor wake its sandbox, and do not bump `lastActivity`. Session metadata
is authoritative and projected to Directory with a revision, so stale updates
are dropped. If that projection fails the request errors; retrying the same
change repairs Directory. Existing records without `archivedAt` remain active.

## Preview

Start the session's app in its sandbox, listening on `0.0.0.0` (for example,
Vite with `npm run dev -- --host 0.0.0.0 --port 5173`). In the panel's Preview
view, enter its port and press Go/Enter, or use **Find listening ports** and
pick one. The last applied port is saved per session in localStorage; reload
remounts the iframe, and the adjacent link opens the same URL in a new tab.
Ports must be 1024–65535 except **3000**, the Sandbox control server; run Next
on e.g. 3001 instead. On macOS celld can only reach ports the image declares
with `EXPOSE` (see `apps/worker/Dockerfile`: 3001 4000 4173 4321 5000 5173 5174 8000 8080
8787 8888); a new image applies to new containers.

The UI's own dev server is **http://localhost:5176**. The iframe goes straight
to celld at **http://p<port>-<sessionId>.localhost:8093/**, not through Vite's
API proxy. Host routing preserves absolute asset paths, app `/api` routes,
and WebSocket upgrades for HMR. This is a local, plain-HTTP preview: celld
must be on the browser's machine. App framing restrictions (CSP or
X-Frame-Options) are preserved; use the new-tab link if embedding is blocked.

## Terminal

The panel's Terminal view uses ghostty-web and `GET /api/session/:id/terminal`
(WebSocket). It attaches to a dedicated SDK session, `terminal-<id>`, in the
same sandbox as the agent, initially in the repo's cwd (or `/workspace`).
Reconnects and other browsers attach to that same shell; terminal `exit`
doesn't kill the agent's exec shell. A dropped connection retries up to ten
times with backoff; the toolbar button retries manually. An explicit shell
exit or PTY error stops automatic retries.

The view fits after Trellis attaches and sizes it. App theme changes recreate
the renderer and reattach to the shell: ghostty-web 0.4.0 cannot fully update
WASM theme colors in place. Reconnection uses the SDK's PTY buffer replay,
not a separately persisted terminal transcript.

