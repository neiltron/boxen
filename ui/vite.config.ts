import { createServer } from "node:http";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  plugins: [react(), tailwindcss(), oauthCallbacks()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5176,
    // Same-origin API + WebSockets: Safari refuses cross-origin ws:// to the
    // literal 127.0.0.1, so the UI talks only to localhost:5173 and vite
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
