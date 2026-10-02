import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
        target: "http://127.0.0.1:8093",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
