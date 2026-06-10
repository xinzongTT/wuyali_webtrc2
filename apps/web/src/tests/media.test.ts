import { describe, expect, it } from "vitest";
import {
  audioLevelToMeterPercent,
  buildAudioConstraints,
  buildVideoSenderParameters,
  buildVideoConstraints,
  calculateBitrateBps,
  formatBitrate,
  formatHealthLabel,
  formatPathLabel,
  isIosLike,
  isVideoStalled
} from "../media";

describe("media constraints", () => {
  it("requests portrait 1080p 30fps from the rear camera by default", () => {
    expect(buildVideoConstraints()).toEqual({
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: { ideal: "environment" }
    });
  });

  it("uses browser-native AUTO audio constraints by default like VDO", () => {
    expect(buildAudioConstraints("Mozilla/5.0")).toBe(true);
    expect(buildAudioConstraints("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe(true);
    expect(isIosLike("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)")).toBe(true);
  });

  it("keeps 1080p capture but disables extra audio processing in low latency mode", () => {
    expect(buildVideoConstraints(undefined, "low-latency")).toEqual({
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: { ideal: "environment" }
    });
    expect(buildAudioConstraints("Mozilla/5.0", undefined, "low-latency")).toEqual({
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false
    });
  });

  it("keeps browser processing when a specific microphone is selected", () => {
    expect(buildAudioConstraints("Mozilla/5.0", "mic-1", "quality")).toEqual({
      deviceId: { exact: "mic-1" },
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: true
    });
  });

  it("uses maintain-framerate sender settings for low latency mode", () => {
    expect(buildVideoSenderParameters({}, "quality")).toMatchObject({
      encodings: [{ maxBitrate: 6_000_000, maxFramerate: 30 }]
    });
    expect(buildVideoSenderParameters({}, "low-latency")).toMatchObject({
      degradationPreference: "maintain-framerate",
      encodings: [{ maxBitrate: 4_000_000, maxFramerate: 30 }]
    });
  });
});

describe("viewer health", () => {
  it("marks a video stalled when frames and bytes stop increasing", () => {
    expect(isVideoStalled({
      previous: { framesDecoded: 100, bytesReceived: 2000, checkedAt: 0 },
      current: { framesDecoded: 100, bytesReceived: 2000, checkedAt: 6000 },
      thresholdMs: 5000
    })).toBe(true);
  });

  it("keeps video healthy when frames increase", () => {
    expect(isVideoStalled({
      previous: { framesDecoded: 100, bytesReceived: 2000, checkedAt: 0 },
      current: { framesDecoded: 101, bytesReceived: 2200, checkedAt: 6000 },
      thresholdMs: 5000
    })).toBe(false);
  });
});

describe("formatting", () => {
  it("formats bitrate and path labels without raw object text", () => {
    expect(formatBitrate(2_850_000)).toBe("2.9 Mbps");
    expect(formatPathLabel({ path: "TURN", protocol: "udp", fps: 30 })).toBe("TURN UDP · 30 fps");
    expect(formatHealthLabel({
      rttMs: 42,
      packetsLost: 2,
      jitterMs: 18,
      availableOutgoingKbps: 2734
    })).toBe("RTT 42 ms · loss 2 · jitter 18 ms · avail 2734 kbps");
    expect(formatPathLabel({})).toBe("检测中");
    expect(formatHealthLabel({})).toBe("诊断中");
  });

  it("maps microphone rms into a stable meter percentage", () => {
    expect(audioLevelToMeterPercent(0)).toBe(0);
    expect(audioLevelToMeterPercent(0.02)).toBeGreaterThan(audioLevelToMeterPercent(0.002));
    expect(audioLevelToMeterPercent(1)).toBe(100);
  });
});

describe("bitrate calculation", () => {
  it("calculates actual media bitrate from byte deltas", () => {
    expect(calculateBitrateBps({
      previous: { bytes: 1_000, checkedAt: 1_000 },
      current: { bytes: 751_000, checkedAt: 3_000 }
    })).toBe(3_000_000);
  });

  it("returns zero when samples are missing or time does not advance", () => {
    expect(calculateBitrateBps({ previous: null, current: { bytes: 1000, checkedAt: 1000 } })).toBe(0);
    expect(calculateBitrateBps({
      previous: { bytes: 1000, checkedAt: 1000 },
      current: { bytes: 2000, checkedAt: 1000 }
    })).toBe(0);
  });
});
