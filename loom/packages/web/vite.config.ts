import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Engine listens on :8787 (http + ws + webhook). Dev server proxies the bridge.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // reachable from the Windows browser against the WSL host
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/webhook": { target: "http://localhost:8787" },
    },
  },
  preview: { port: 4173, host: true },
});
