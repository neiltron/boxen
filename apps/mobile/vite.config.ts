import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Served at /m/ beside the web app: the installer builds it into the
  // worker's assets (ops/boxenctl.ts), so the API is same-origin.
  base: "/m/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // The web app's components, hooks and lib, imported as its own code imports them.
    alias: { "@": path.resolve(__dirname, "../ui/src") },
    // Those files resolve react from apps/ui; one copy for both.
    dedupe: ["react", "react-dom"],
  },
  // sqlite-wasm finds its .wasm next to its module; prebundling would move it.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  server: {
    port: 5177,
    strictPort: true, // the HTTPS proxy in front names this port
    // The phone needs HTTPS for OPFS: reach this through Caddy or Tailscale
    // Serve. Vite listens on localhost, which can be ::1 only, so point the
    // proxy at localhost, not 127.0.0.1:
    //   tailscale serve --bg --https=5177 http://localhost:5177
    allowedHosts: [".oxen.sh", ".ts.net"],
    // Same-origin API and WebSockets, as apps/ui's dev server does.
    proxy: { "/api": { target: "http://127.0.0.1:8093", changeOrigin: true, ws: true } },
  },
  // The built app (vite build && vite preview), on the same port and hosts.
  preview: { port: 5177, strictPort: true, allowedHosts: [".oxen.sh", ".ts.net"] },
});
