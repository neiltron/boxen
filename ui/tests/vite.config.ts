import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// An isolated real-Trellis fixture: no cell backend, OAuth listeners, or app
// dependency scan needed to exercise docking and browser keyboard focus.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  optimizeDeps: { entries: ["tests/workspace.html"] },
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
