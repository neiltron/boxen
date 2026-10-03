import { createServer } from "node:http";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const API = "http://127.0.0.1:8093";

// pi-ai's OAuth sign-ins redirect to fixed loopback addresses on the browser's
// machine (OpenAI/Codex :1455, Radius :1456, Anthropic :53692). Cells can't
// listen on ports, so the dev server does and forwards the redirect to the
// cell that holds the sign-in. A port in use (e.g. a host pi signing in) is
// skipped; pasting the address still works then.
function oauthCallbacks(ports = [1455, 1456, 53692]): Plugin {
  return {
    name: "oauth-callbacks",
    configureServer(server) {
      const listeners = ports.map((port) => createServer(async (req, res) => {
        const original = `http://${req.headers.host}${req.url}`;
        try {
          const upstream = await fetch(`${API}/api/auth/callback?u=${encodeURIComponent(original)}`);
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/html" });
          res.end(await upstream.text());
        } catch (e) {
          res.writeHead(502).end(`pi sessions API unreachable: ${(e as Error).message}`);
        }
      }).on("error", () => {}).listen(port, "127.0.0.1"));
      server.httpServer?.on("close", () => listeners.forEach((l) => l.close()));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), oauthCallbacks(), VitePWA({
    // No HMR in the installed app, and no surprise refresh during a session.
    registerType: "prompt",
    injectRegister: false,
    manifest: {
      id: "/",
      name: "pi sessions",
      short_name: "pi sessions",
      description: "Durable, shared pi agent sessions",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#171717",
      theme_color: "#171717",
      icons: [
        { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
        { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
        { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    workbox: {
      // Only build artifacts. No API responses, credentials, conversation
      // snapshots, preview pages, or command/background-sync queue.
      // Don't download hundreds of lazy syntax grammars just to install.
      // The entry bundle is self-contained; lazy panel assets cache on use.
      globPatterns: ["index.html", "assets/index-*.{js,css}", "assets/workbox-window*.js", "assets/*.woff2"],
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      navigateFallback: "index.html",
      navigateFallbackAllowlist: [/^\/(?:\?.*)?$/],
      cleanupOutdatedCaches: true,
      runtimeCaching: [{
        urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/assets/"),
        handler: "CacheFirst",
        options: {
          cacheName: "pids-static-assets",
          cacheableResponse: { statuses: [200] },
          expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true },
        },
      }],
    },
    includeAssets: ["favicon.svg", "apple-touch-icon.png", "pwa-*.png"],
  })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5176,
    // Reached as https://a.oxen.sh through Caddy (../Caddyfile), tailnet only.
    allowedHosts: ["a.oxen.sh"],
    // Same-origin API + WebSockets: Safari refuses cross-origin ws:// to the
    // literal 127.0.0.1, so the UI talks only to its own origin and vite
    // proxies (including upgrades) to the celld node.
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
