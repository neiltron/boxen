import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same-origin API and WebSockets, proxied to the celld node like the web app's.
export default defineConfig({
  plugins: [react()],
  server: { port: 5177, proxy: { "/api": { target: "http://127.0.0.1:8093", changeOrigin: true, ws: true } } },
});
