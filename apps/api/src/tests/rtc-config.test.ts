import { describe, expect, it } from "vitest";
import { buildRtcConfig, summarizeCandidatePair } from "../rtc-config.js";

describe("buildRtcConfig", () => {
  it("returns direct-first ICE config with TURN fallbacks", () => {
    const config = buildRtcConfig({
      stunUrls: "stun:stun.l.google.com:19302",
      turnUrls: "turn:zb.tkwuyali.com:3478?transport=udp, turn:zb.tkwuyali.com:3478?transport=tcp",
      turnUsername: "live",
      turnCredential: "secret",
      forceRelay: false
    });

    expect(config.iceTransportPolicy).toBe("all");
    expect(config.iceServers).toEqual([
      { urls: ["stun:stun.l.google.com:19302"] },
      {
        urls: [
          "turn:zb.tkwuyali.com:3478?transport=udp",
          "turn:zb.tkwuyali.com:3478?transport=tcp"
        ],
        username: "live",
        credential: "secret"
      }
    ]);
  });

  it("can force relay for diagnostics", () => {
    const config = buildRtcConfig({
      stunUrls: "",
      turnUrls: "turn:turn.example.com:3478?transport=udp",
      turnUsername: "diagnostic",
      turnCredential: "secret",
      forceRelay: true
    });

    expect(config.iceTransportPolicy).toBe("relay");
  });
});

describe("summarizeCandidatePair", () => {
  it("reports relay udp from selected candidate stats", () => {
    const summary = summarizeCandidatePair({
      localCandidateType: "relay",
      remoteCandidateType: "srflx",
      protocol: "udp",
      currentRoundTripTime: 0.042,
      availableOutgoingBitrate: 2_800_000
    });

    expect(summary).toEqual({
      path: "TURN",
      localCandidateType: "relay",
      remoteCandidateType: "srflx",
      protocol: "udp",
      rttMs: 42,
      availableOutgoingKbps: 2734
    });
  });
});
