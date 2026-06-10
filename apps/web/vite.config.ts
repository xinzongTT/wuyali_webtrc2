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
  test: {
    exclude: ["dist/**", "node_modules/**"],
    globals: true,
    environment: "jsdom"
  }
});
