import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

import gracefulShutdown from "./src/graceful-shutdown.ts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), gracefulShutdown()],
  server: {
    proxy: {
      // Frontend calls ``fetch('/api/run-stream', ...)``; Vite forwards
      // to the bridge spawned by extra-rare-agentic-bert.py.
      "/api": {
        target: "http://127.0.0.1:8338",
        changeOrigin: true,
      },
    },
  },
});