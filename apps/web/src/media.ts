export type VideoHealthSample = {
  framesDecoded: number;
  bytesReceived: number;
  checkedAt: number;
};

export type BitrateSample = {
  bytes: number;
  checkedAt: number;
};

export type LatencyMode = "quality" | "low-latency";

export type VideoSenderParameters = Partial<RTCRtpSendParameters> & {
  encodings: RTCRtpEncodingParameters[];
  degradationPreference?: RTCDegradationPreference;
};

export function buildVideoConstraints(deviceId?: string, _mode: LatencyMode = "quality"): MediaTrackConstraints {
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } })
  };
}

export function buildAudioConstraints(
  userAgent = navigator.userAgent,
  deviceId?: string,
  mode: LatencyMode = "quality"
): true | MediaTrackConstraints {
  const lowLatency = mode === "low-latency";
  if (!deviceId && !lowLatency) return true;

  const constraints: MediaTrackConstraints = lowLatency
    ? {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
      }
    : {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true
      };

  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  if (isIosLike(userAgent)) {
    return constraints;
  }

  return constraints;
}

export function buildVideoSenderParameters(
  parameters: Partial<RTCRtpSendParameters>,
  mode: LatencyMode = "quality"
): VideoSenderParameters {
  const currentEncoding = parameters.encodings?.[0] ?? {};
  const next: VideoSenderParameters = {
    ...parameters,
    encodings: [{
      ...currentEncoding,
      maxBitrate: mode === "low-latency" ? 6_000_000 : 8_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1
    }]
  };
  next.degradationPreference = mode === "low-latency" ? "maintain-framerate" : "maintain-resolution";
  return next;
}

export function isIosLike(userAgent: string) {
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile|Safari/.test(userAgent));
}

export function audioLevelToMeterPercent(rms: number) {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(Math.log10(1 + rms * 120) * 70)));
}

export function formatBitrate(bitsPerSecond: number | null | undefined) {
  if (!bitsPerSecond || bitsPerSecond <= 0) return "0 kbps";
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function calculateBitrateBps(input: { previous: BitrateSample | null; current: BitrateSample }) {
  if (!input.previous) return 0;
  const elapsedMs = input.current.checkedAt - input.previous.checkedAt;
  const byteDelta = input.current.bytes - input.previous.bytes;
  if (elapsedMs <= 0 || byteDelta <= 0) return 0;
  return Math.round((byteDelta * 8 * 1000) / elapsedMs);
}

export function formatPathLabel(input: { path?: string | null; protocol?: string | null; fps?: number | null }) {
  const path = input.path ? input.path.toUpperCase() : "检测中";
  const protocol = input.protocol ? ` ${input.protocol.toUpperCase()}` : "";
  const fps = input.fps == null ? "" : ` · ${Math.round(input.fps)} fps`;
  return `${path}${protocol}${fps}`;
}

export function formatHealthLabel(input: {
  rttMs?: number | null;
  packetsLost?: number | null;
  jitterMs?: number | null;
  availableOutgoingKbps?: number | null;
}) {
  const parts: string[] = [];
  if (input.rttMs != null) parts.push(`RTT ${input.rttMs} ms`);
  if (input.packetsLost != null) parts.push(`loss ${input.packetsLost}`);
  if (input.jitterMs != null) parts.push(`jitter ${input.jitterMs} ms`);
  if (input.availableOutgoingKbps != null) parts.push(`avail ${input.availableOutgoingKbps} kbps`);
  return parts.length > 0 ? parts.join(" · ") : "诊断中";
}

export function formatDeviceLabel(device: Pick<MediaDeviceInfo, "kind" | "label">, index: number) {
  const raw = device.label.trim();
  if (device.kind === "videoinput") {
    const lower = raw.toLowerCase();
    if (/(back|rear|environment|后|背)/.test(lower)) return "后置摄像头";
    if (/(front|facetime|user|前|正)/.test(lower)) return "前置摄像头";
    return raw ? `摄像头 ${index + 1} · ${raw}` : `摄像头 ${index + 1}`;
  }
  if (device.kind === "audioinput") {
    return `麦克风 ${index + 1}`;
  }
  return raw || `设备 ${index + 1}`;
}

export function formatVideoDimensions(width?: number | null, height?: number | null, portrait = false) {
  if (!width || !height || width <= 0 || height <= 0) return "";
  if (!portrait) return `${width}x${height}`;
  return `${Math.min(width, height)}x${Math.max(width, height)}`;
}

export function isVideoStalled(input: {
  previous: VideoHealthSample | null;
  current: VideoHealthSample;
  thresholdMs: number;
}) {
  if (!input.previous) return false;
  if (input.current.checkedAt - input.previous.checkedAt < input.thresholdMs) return false;
  return input.current.framesDecoded <= input.previous.framesDecoded &&
    input.current.bytesReceived <= input.previous.bytesReceived;
}

export async function listMediaDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((device) => device.kind === "videoinput"),
    microphones: devices.filter((device) => device.kind === "audioinput")
  };
}

export function readTrackSettings(stream: MediaStream) {
  const video = stream.getVideoTracks()[0]?.getSettings();
  const audio = stream.getAudioTracks()[0]?.getSettings();
  return { video, audio };
}
