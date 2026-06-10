import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:4200",
      "/ws": {
        target: "ws://localhost:4200",
        ws: true
      }
    }
  },
  preview: {
    allowedHosts: [
      "zhibo.tkwuyali.com",
      "webtrc2.192-129-147-54.sslip.io"
    ]
  },
  test: {
    exclude: ["dist/**", "node_modules/**"],
    globals: true,
    environment: "jsdom"
  }
});
