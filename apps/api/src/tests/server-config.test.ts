import { describe, expect, it } from "vitest";
import { applyEnvironmentSettings } from "../server-config.js";
import { createMemoryStore } from "../store.js";

describe("server environment settings", () => {
  it("uses Google and Cloudflare STUN by default", async () => {
    const store = createMemoryStore();

    await expect(store.getSettings()).resolves.toMatchObject({
      stunUrls: "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478"
    });
  });

  it("does not overwrite saved TURN settings with empty environment defaults", async () => {
    const store = createMemoryStore({
      settings: {
        stunUrls: "stun:stun.example.test:3478",
        turnUrls: "turn:existing.example.test:3478",
        turnUsername: "existing-user",
        turnCredential: "existing-password",
        forceRelay: true,
        lowLatencyDefault: false
      }
    });

    await applyEnvironmentSettings(store, {});

    await expect(store.getSettings()).resolves.toMatchObject({
      turnUrls: "turn:existing.example.test:3478",
      turnUsername: "existing-user",
      turnCredential: "existing-password"
    });
  });

  it("fills TURN settings from environment when saved settings are empty", async () => {
    const store = createMemoryStore();

    await applyEnvironmentSettings(store, {
      TURN_URLS: "turn:fresh.example.test:3478",
      TURN_USERNAME: "fresh-user",
      TURN_CREDENTIAL: "fresh-password"
    });

    await expect(store.getSettings()).resolves.toMatchObject({
      turnUrls: "turn:fresh.example.test:3478",
      turnUsername: "fresh-user",
      turnCredential: "fresh-password"
    });
  });
});
