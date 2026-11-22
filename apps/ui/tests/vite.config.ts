import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated real-component fixtures: no cell backend or OAuth listeners.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  optimizeDeps: { entries: ["tests/workspace.html", "tests/model-picker.html"] },
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
