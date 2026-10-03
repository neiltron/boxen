# pi sessions web client

React + Vite. `npm ci`, then `npm run dev` for development on :5176. Vite
proxies `/api` and WebSockets to celld on :8093, and listens on the loopback
OAuth callback ports. **Do not use the development server as the mobile app:**
Vite's HMR client can reload the document after a dropped connection.

## Built / installable client

From `pi-durable-sessions/`:

```sh
npm --prefix ui ci
npm run ui:build
./deploy.sh         # includes the new WebSocket ping/pong handlers
./caddy.sh          # HTTPS, static ui/dist + /api directly to celld
```

`caddy.sh` sets the absolute static root and checks a build exists. On later
UI changes, rebuild; no Vite server or Caddy restart is required. The existing
Caddy process must be restarted once when switching from the old dev proxy.
Keep `npm run ui` running separately if you want automatic loopback OAuth
callbacks on the host; otherwise paste the callback URL into Providers.
The HTTPS route remains tailnet-only, with the existing certificate setup.

Open https://a.oxen.sh, then on iOS use **Share → Add to Home Screen → Open as
Web App** (wording varies by iOS version), or use the browser's **Install app**
menu on Android/desktop. A manifest, opaque PNG icons (including maskable and
Apple touch variants), and a production-only service worker enable standalone
launches. Installation requires HTTPS (localhost is allowed for tests). No
install prompt or notification permission is requested automatically.

`npm run build && npm run preview -- --port 4176` is a local PWA smoke-test
server, not the deployment server. Vite preview inherits the `/api` proxy.
The manifest/worker are disabled during `npm run dev`; use a separate origin
for development to avoid an installed worker controlling the dev server.

## Resume and offline behavior

- Selection lives in `?session=<id>`, so reloads and independent tabs keep
  their session, and Back/Forward work. A fresh `/` home-screen launch restores
  `pids.selectedSession` from localStorage. An empty/loading directory never
  clears the selection. Unknown/unavailable sessions stay selected; use the
  sidebar to pick another. Storage denial falls back to the URL.
- Foreground, BFCache restore, and network recovery reconnect the session and
  directory WebSockets, **not the page**. Heartbeat responses detect half-open
  connections. Reconnects leave the old transcript visible until a complete
  replacement snapshot arrives, preserving the mounted chat and scroll. Scroll
  position is not persisted across an actual document reload/OS eviction.
- Unsent text lives in per-session **sessionStorage** (tab-local), survives
  reload/update where the browser preserves that storage, and is removed after
  a successful socket send. This is not delivery acknowledgement or a send
  queue. Commands are disabled until the session has rejoined; nothing is
  automatically retried or submitted later.
- The worker precaches only the app shell: entry HTML/JS/CSS, bundled fonts,
  the registration helper, and app icons. Lazy panel/syntax-highlighting assets
  under same-origin `/assets/` cache on use (bounded to 100 entries / 30 days),
  rather than downloading hundreds of grammars on installation. Unvisited panel
  features may need the network. It never caches API/auth responses, transcripts,
  artifacts, sandbox previews,
  or WebSocket traffic. Only `/` navigation (with any session query) falls back
  to the app shell, **not `/api` or other paths**. There is no background sync.
- After one successful online visit, the shell can launch offline. An already
  mounted transcript stays readable; a cold offline launch cannot load the
  conversation or directory until the server is reachable. A banner explains
  offline status; session connection status also covers server/tailnet outages
  that `navigator.onLine` cannot detect.
- Updates download in the background and wait. **Reload to update** is explicit;
  **Later** keeps working on the current version. Foregrounding only checks for
  updates—it never accepts one. The worker is shared across same-origin tabs,
  so accepting an update may reload other open tabs too (selection/drafts are
  retained). To reset the cache, remove the site's service worker and site data
  in browser settings/devtools; this also clears saved preferences.

A PWA does **not** stop iOS from freezing/evicting pages or guarantee background
WebSocket execution. Agent execution remains server-side. Push notifications
are a follow-up: they need permission UX, per-user/device subscriptions,
server-side Web Push delivery and notification click routing. On iOS, Web Push
requires an installed home-screen app and iOS 16.4+. None is implemented here.

## Checks

```sh
npm test                         # reducer + socket lifecycle/timers
npm run lint                     # existing React compiler warnings remain
npm run build
npx playwright install chromium  # install-deps may also be needed on Linux
npm run test:browser              # mobile viewport, built UI, mocked API/WS
npm run icons                    # regenerate PNGs from favicon.svg (Chromium)
```

Browser checks cover selection/draft restoration, independent tabs/history,
foreground transcript/scroll retention, offline shell and API exclusion,
install metadata/icons, and a waiting worker update with no automatic reload.
They use a real browser/service worker but mock celld; they don't prove iOS
lifecycle behavior, actual install UI, real tailnet recovery, or push delivery.

Before deploying broadly, smoke-test on the target iPhone:

1. In Safari and the home-screen app, select a long session, scroll up, type a
   draft, switch apps/lock the phone, and return. No picker or document reload;
   transcript/draft remain, socket rejoins, and new events arrive.
2. Repeat with airplane mode, tailnet disconnected, and celld restarted. No
   lost draft or queued sends. Reconnect, then send once and observe one input.
3. Force-close/reload the app. Selection restores; the server reloads the
   transcript when reachable. Check a second tab on a different session.
4. Rebuild the UI. Return to an old window, choose Later, and verify no refresh.
   Accept the update and verify selection/draft restoration.
5. Check portrait/landscape, home indicator/status-bar spacing, keyboard and
   composer, sidebar drawer, and icon appearance after installation.
