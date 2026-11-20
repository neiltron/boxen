# Using boxen

This guide covers day-to-day use of the boxen web app: connecting providers, creating Sessions, navigating the workspace, archiving, live previews, and the sandbox terminal.

## Model providers and sandbox tokens

Open **Providers** at the bottom of the sidebar to configure model credentials and sandbox tokens. All credentials live on the server (in the Directory cell); nothing is copied from a local `pi` configuration on the host.

### Connecting a model provider

boxen supports every model provider available in `pi`:

- **API key:** Expand a provider, paste your API key, and click **Save**.
- **OAuth sign-in:** Expand a provider that supports sign-in and click its sign-in button. A browser tab opens to complete authentication.
  - **Remote servers (paste redirect URL):** Provider OAuth flows redirect to a `localhost` callback URL. When accessing boxen on another machine (such as over Tailscale), your browser will land on a `localhost` address that fails to load. Copy that full URL from the browser's address bar, paste it into the field under the provider in boxen, and click **Finish**.

### Sandbox tokens

At the bottom of the **Providers** sheet, you can set optional tokens that are injected into the environment of every command run in a sandbox:

| Token | Used for |
| --- | --- |
| `GH_TOKEN` | Repository and branch autocomplete when creating a Session, private `git clone`, `git push`, and the `gh` CLI |
| `LINEAR_API_KEY` | Linear API calls made from inside a sandbox |

Saved token values are write-only in the UI and never sent back to the browser. Because the agent can read environment variables in its sandbox, use narrowly scoped tokens.

## Creating and running a Session

1. Click **+** at the top of the sidebar.
2. *(Optional)* Enter a Git repository URL—or type to search repositories visible to your `GH_TOKEN`—and choose a branch if you don't want the default.
3. Click **Create**.

Select a model from the picker at the bottom of the composer and send a prompt. Press **Enter** to send (**Shift+Enter** inserts a newline; on touch keyboards, Return inserts a newline and the send button submits). Sending a message while the agent is actively running steers the run; click the stop button to abort the current turn.

### How `/workspace` persistence works

Each Session runs inside its own Linux container:

- **Initial clone:** If you supplied a repository, boxen clones it once into `/workspace` (and includes the repo's `AGENTS.md` in the agent's prompt).
- **Checkpointing:** After each completed turn—and before a container goes to sleep from inactivity—boxen checkpoints `/workspace` (excluding `node_modules`) to object storage.
- **Sleep and restarts:** When a container sleeps or restarts, the next agent tool call, Changes diff, or Terminal connection starts a fresh container and restores `/workspace` from the latest checkpoint. Background processes are not preserved across restarts, and uncommitted file edits made outside a completed turn are lost if the server stops before a checkpoint runs.

## Workspace layout and keyboard shortcuts

Each Session opens a resizable, dockable Trellis workspace with chat on the left and a five-tab side panel on the right:

- **Artifacts:** Versioned documents (Markdown, HTML, SVG, Mermaid, code) produced by the agent's `artifact` tool. Readable even while the sandbox sleeps.
- **Changes:** Live `git diff` of the working tree against `HEAD`, including untracked files.
- **Preview:** Embedded HTTP preview of web apps running inside the sandbox.
- **Terminal:** Interactive Bash shell inside the sandbox container.
- **Events:** Raw Session event stream for inspecting agent activity.

Your panel arrangement is saved per browser in `localStorage`. Desktop and phone layouts are stored separately—on phones, the panel starts hidden beneath the chat.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+J` / `Ctrl+Alt+K` (`Cmd+Alt+J` / `Cmd+Alt+K` on macOS) | Focus the next / previous visible panel. From the session list or anywhere outside the active workspace, either shortcut focuses the chat composer first. In the default two-panel layout, subsequent presses alternate between chat and the side panel. |
| `F6` / `Shift+F6` | Cycle to the next / previous visible panel while focus is inside the workspace (including the composer). Outside the workspace, `F6` keeps its standard browser behavior. |
| `Ctrl+Alt+]` / `Ctrl+Alt+[` (`Cmd+Alt+]` / `Cmd+Alt+[` on macOS) | Switch to the next / previous tab within a Trellis panel. |

**Notes on panel controls:**

- Panel shortcuts change keyboard focus only—they do not switch the selected Session.
- The panel toggle button in the top-right corner of the chat header hides or restores entire tab groups while keeping their docking, tab order, active tab, and proportions. Hidden groups are skipped when cycling focus.
- Global panel shortcuts are inactive when no Session is selected, do not escape open dialogs (such as Providers or Rename), and ignore IME/AltGr composition.
- Embedded Preview and artifact iframes have their own keyboard context—click outside the iframe to use workspace shortcuts.

## Rename and archive

Open the **⋯** menu on a sidebar row or in the session header to **Rename** or **Archive** a Session.

- **Rename:** Names are trimmed, capped at 120 characters, and synced to all connected viewers. A manual rename takes precedence over an automatic title that is still being generated.
- **Archive is organizational, not a shutdown:** Archiving hides a Session from the **Active** list for everyone without stopping a running agent, deleting files, or making the transcript read-only. Ongoing agent activity does not unarchive it.
- **Restoring:** Switch the sidebar filter to **Archived** and choose **Restore** from the **⋯** menu—or click **Undo** in the confirmation toast right after archiving. Archiving the currently open Session keeps it visible along with any unsent draft and displays an **Archived** badge in the header.

Programmatically, `PATCH /api/session/:id` accepts `{ "name": "New title" }` and/or `{ "archived": true }` (`false` restores). Metadata updates do not wake the sandbox or update `lastActivity`.

## Preview

To preview a web server running inside a Session's sandbox:

1. Start your dev server listening on `0.0.0.0` (not `127.0.0.1`), for example:
   ```sh
   npm run dev -- --host 0.0.0.0 --port 5173
   ```
2. Open the **Preview** tab in the side panel.
3. Enter the port and click **Go** (or press **Enter**), or click **Find listening ports** to detect and pick a running port.

The last applied port is remembered per Session in `localStorage`. Use the reload button to remount the iframe, or the external-link button to open the preview in a new browser tab.

### Port rules and platform limits

- **Allowed range:** Ports `1024–65535`, except **3000** (reserved for the sandbox control server). For frameworks that default to `3000` (such as Next.js), run on `3001` or another open port instead.
- **macOS `EXPOSE` list:** On macOS, `celld` can only reach container ports declared with `EXPOSE` in `apps/worker/Dockerfile`: `3001`, `4000`, `4173`, `4321`, `5000`, `5173`, `5174`, `8000`, `8080`, `8787`, and `8888`. Adding a port requires rebuilding the sandbox image and applies to new containers. Linux hosts have no `EXPOSE` restriction.

### Preview routing and remote servers

The Preview iframe loads directly from `celld` at `http://p<port>-<sessionId>.localhost:8093/` rather than going through Vite's dev proxy on `:5176`. Host-based routing preserves root-relative asset paths, `/api` routes, and HMR WebSocket upgrades.

Because preview URLs use plain HTTP on `*.localhost:8093`, `celld` must be reachable on port `8093` on your browser's machine. When boxen is running on a remote Linux server, forward port `8093` over SSH and open the local HTTP UI to avoid mixed-content blocks:

```sh
ssh -N -L 8093:127.0.0.1:8093 your-server
# Open http://localhost:8093 in your browser
```

If an app sends `CSP` or `X-Frame-Options` headers that block iframe embedding, boxen preserves them—use the open-in-new-tab button instead.

## Terminal

The **Terminal** tab provides an interactive Bash shell inside the Session's sandbox, rendered with `ghostty-web` over `GET /api/session/:id/terminal` (WebSocket).

- **Dedicated shared shell:** The terminal attaches to a dedicated sandbox session (`terminal-<id>`) starting in the repository's working directory (or `/workspace`). Reconnecting or opening the Session in another browser attaches to that same shell.
- **Isolated from the agent:** Running `exit` closes only your interactive terminal shell; it does not affect the agent's exec shell.
- **Automatic reconnection:** Dropped connections retry up to 10 times with exponential backoff, and the toolbar button lets you reconnect manually. An explicit shell `exit` or PTY error stops automatic retries.
- **Theme changes and scrollback:** Switching between light and dark themes reattaches cleanly to the same live shell. Reconnection replays the sandbox's PTY buffer rather than reading a separately stored terminal transcript.
