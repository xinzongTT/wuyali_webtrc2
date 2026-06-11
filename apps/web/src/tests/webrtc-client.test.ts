import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveClient, lockVideoSdpBitrate } from "../webrtc-client";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = "stable";
  closed = false;
  restartIceCalls = 0;
  stats = new Map<string, any>();
  remoteDescriptionCalls = 0;

  constructor(_config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0" } as RTCSessionDescriptionInit;
  }

  async createAnswer() {
    return { type: "answer", sdp: "v=0" } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    if (description.type === "offer") this.signalingState = "have-local-offer";
    if (description.type === "answer") this.signalingState = "stable";
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescriptionCalls += 1;
    if (description.type === "answer" && this.signalingState !== "have-local-offer") {
      throw new Error(`wrong state: ${this.signalingState}`);
    }
    this.signalingState = "stable";
  }
  async addIceCandidate(_candidate: unknown) {}
  addTrack(_track: MediaStreamTrack, _stream: MediaStream) {
    return { getParameters: () => ({}), setParameters: vi.fn() } as unknown as RTCRtpSender;
  }
  addTransceiver(_track: MediaStreamTrack, _init: RTCRtpTransceiverInit) {
    return {
      sender: { getParameters: () => ({}), setParameters: vi.fn() }
    } as unknown as RTCRtpTransceiver;
  }
  async getStats() {
    return this.stats;
  }
  restartIce() {
    this.restartIceCalls += 1;
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ iceServers: [], iceTransportPolicy: "all" })
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveClient", () => {
  it("locks offer SDP to a high enough bitrate for 1080p video", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 VP8/90000"
    ].join("\r\n");

    expect(lockVideoSdpBitrate(sdp)).toContain("b=TIAS:8000000");
    expect(lockVideoSdpBitrate(sdp)).toContain("x-google-start-bitrate=8000");
  });

  it("does not reconnect after the user stops the client", () => {
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      onStatus: vi.fn()
    });

    client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    client.stop();
    vi.advanceTimersByTime(2000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("sends signaling heartbeats while connected", async () => {
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onopen?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(FakeWebSocket.instances[0].sent.some((message) => message.includes('"type":"heartbeat"'))).toBe(true);
    client.stop();
  });

  it("closes an existing peer before recreating the same peer id", async () => {
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0].closed).toBe(true);
  });

  it("rebuilds a broadcaster peer and sends a fresh offer when recovery times out", async () => {
    const recoveryEvents: any[] = [];
    const client = new LiveClient({
      role: "broadcaster",
      roomId: "room001",
      localStream: fakeStream(),
      onStatus: vi.fn(),
      onRecoveryEvent: (event) => recoveryEvents.push(event)
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "viewer-ready", roomId: "room001", peerId: "viewer-1" })
    });
    await flushPromises();

    const firstPeer = FakePeerConnection.instances[0];
    firstPeer.connectionState = "disconnected";
    firstPeer.onconnectionstatechange?.();
    await flushPromises();

    expect(firstPeer.restartIceCalls).toBe(1);
    expect(recoveryEvents.at(-1)).toMatchObject({
      type: "stream_interrupted",
      detail: "推流连接异常，正在恢复直播",
      stats: {
        peerId: "viewer-1",
        reason: "peer-unhealthy",
        connection: "disconnected"
      }
    });
    expect(FakeWebSocket.instances[0].sent.filter((message) => message.includes('"type":"offer"'))).toHaveLength(2);
    vi.advanceTimersByTime(5500);
    await flushPromises();

    expect(firstPeer.closed).toBe(true);
    expect(FakePeerConnection.instances).toHaveLength(2);
    const offers = FakeWebSocket.instances[0].sent.filter((message) => message.includes('"type":"offer"'));
    expect(offers).toHaveLength(3);
  });

  it("reports selected media path, transport health, and bitrate from WebRTC stats", async () => {
    const statuses: any[] = [];
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      onStatus: (status) => statuses.push(status)
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    const peer = FakePeerConnection.instances[0];
    peer.stats = new Map<string, any>([
      ["inbound-video", {
        type: "inbound-rtp",
        kind: "video",
        framesDecoded: 10,
        bytesReceived: 1000,
        framesPerSecond: 30,
        frameWidth: 1080,
        frameHeight: 1920,
        packetsLost: 2,
        jitter: 0.018
      }],
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.042,
        availableOutgoingBitrate: 2_800_000
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "udp"
      }],
      ["remote", {
        id: "remote",
        type: "remote-candidate",
        candidateType: "srflx"
      }]
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    peer.stats.get("inbound-video").bytesReceived = 751000;
    peer.stats.get("inbound-video").framesDecoded = 70;
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(statuses.at(-1)).toMatchObject({
      path: "TURN",
      protocol: "udp",
      resolution: "1080x1920",
      fps: 30,
      rttMs: 42,
      packetsLost: 2,
      jitterMs: 18,
      availableOutgoingKbps: 2734,
      bitrateBps: 3000000
    });
  });

  it("emits stats updates for diagnostic upload", async () => {
    const statsUpdates: any[] = [];
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      onStatus: vi.fn(),
      onStats: (status) => statsUpdates.push(status)
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    const peer = FakePeerConnection.instances[0];
    peer.stats = new Map<string, any>([
      ["inbound-video", {
        type: "inbound-rtp",
        kind: "video",
        framesDecoded: 10,
        bytesReceived: 1000,
        framesPerSecond: 24,
        frameWidth: 1080,
        frameHeight: 1920
      }],
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        selected: true,
        localCandidateId: "local",
        currentRoundTripTime: 0.021
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        candidateType: "host",
        protocol: "udp"
      }]
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(statsUpdates.at(-1)).toMatchObject({
      path: "DIRECT",
      protocol: "udp",
      resolution: "1080x1920",
      fps: 24,
      rttMs: 21
    });
  });

  it("re-announces a viewer when the video element has no playable frames", async () => {
    const recoveryEvents: any[] = [];
    const remoteVideo = fakeRemoteVideo({
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      currentTime: 0
    });
    const statuses: any[] = [];
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: (status) => statuses.push(status),
      onRecoveryEvent: (event) => recoveryEvents.push(event)
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    const firstPeer = FakePeerConnection.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(firstPeer.closed).toBe(true);
    expect(FakeWebSocket.instances[0].sent.some((message) => message.includes('"type":"viewer-ready"'))).toBe(true);
    expect(statuses.at(-1)).toMatchObject({
      recovery: "正在重建接收端"
    });
    expect(recoveryEvents.at(-1)).toMatchObject({
      type: "viewer_media_lost",
      detail: "接收端无可播放画面，已请求重新拉流",
      stats: {
        reason: "media-watchdog",
        readyState: 0,
        videoWidth: 0,
        videoHeight: 0,
        currentTime: 0
      }
    });
  });

  it("keeps a healthy viewer peer when signaling resends an offer for the same broadcaster", async () => {
    const remoteVideo = fakeRemoteVideo({
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
      videoWidth: 1080,
      videoHeight: 1920,
      currentTime: 12
    });
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    const firstPeer = FakePeerConnection.instances[0];
    firstPeer.ontrack?.({ streams: [{} as MediaStream] });
    await flushPromises();

    remoteVideo.currentTime = 13;
    await vi.advanceTimersByTimeAsync(2500);
    await flushPromises();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    expect(firstPeer.closed).toBe(false);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(remoteVideo.load).not.toHaveBeenCalled();
  });

  it("unmutes and plays the viewer video when a remote stream arrives", async () => {
    const remoteVideo = fakeRemoteVideo({
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
      videoWidth: 1080,
      videoHeight: 1920,
      currentTime: 1
    });
    remoteVideo.muted = true;
    remoteVideo.defaultMuted = true;
    remoteVideo.volume = 0.2;
    const stream = {} as MediaStream;
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    FakePeerConnection.instances[0].ontrack?.({ streams: [stream] });
    await flushPromises();

    expect(remoteVideo.srcObject).toBe(stream);
    expect(remoteVideo.muted).toBe(false);
    expect(remoteVideo.defaultMuted).toBe(false);
    expect(remoteVideo.volume).toBe(1);
    expect(remoteVideo.play).toHaveBeenCalled();
  });

  it("keeps healthy viewer media when a signaling restart changes the broadcaster peer id", async () => {
    const remoteVideo = fakeRemoteVideo({
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
      videoWidth: 1080,
      videoHeight: 1920,
      currentTime: 32
    });
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    const firstPeer = FakePeerConnection.instances[0];
    firstPeer.ontrack?.({ streams: [{} as MediaStream] });

    remoteVideo.currentTime = 68;
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-2", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    expect(firstPeer.closed).toBe(false);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(remoteVideo.load).not.toHaveBeenCalled();
  });

  it("marks a viewer signaling reconnect as healthy when media is still playing", async () => {
    const remoteVideo = fakeRemoteVideo({
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
      videoWidth: 1080,
      videoHeight: 1920,
      currentTime: 12
    });
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onopen?.();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();

    const firstPeer = FakePeerConnection.instances[0];
    firstPeer.ontrack?.({ streams: [{} as MediaStream] });
    remoteVideo.currentTime = 18;
    FakeWebSocket.instances[0].onclose?.();
    await vi.advanceTimersByTimeAsync(1500);
    FakeWebSocket.instances[1].onopen?.();

    const reconnectJoin = JSON.parse(FakeWebSocket.instances[1].sent[0]);
    expect(reconnectJoin).toMatchObject({
      type: "join",
      roomId: "room001",
      role: "viewer",
      recoverHealthyPeer: true
    });
    expect(firstPeer.closed).toBe(false);
    expect(remoteVideo.load).not.toHaveBeenCalled();
  });

  it("reports viewer media recovery after a watchdog rebuild gets a new track", async () => {
    const recoveryEvents: any[] = [];
    const remoteVideo = fakeRemoteVideo({
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      currentTime: 0
    });
    const client = new LiveClient({
      role: "viewer",
      roomId: "room001",
      remoteVideo: remoteVideo as unknown as HTMLVideoElement,
      onStatus: vi.fn(),
      onRecoveryEvent: (event) => recoveryEvents.push(event)
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-1", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "offer", roomId: "room001", peerId: "broadcaster-2", sdp: { type: "offer", sdp: "v=0" } })
    });
    await flushPromises();
    remoteVideo.readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
    remoteVideo.videoWidth = 1080;
    remoteVideo.videoHeight = 1920;
    remoteVideo.currentTime = 0.5;
    FakePeerConnection.instances.at(-1)?.ontrack?.({ streams: [{} as MediaStream] });
    await flushPromises();

    expect(recoveryEvents.at(-1)).toMatchObject({
      type: "viewer_media_recovered",
      detail: "接收端画面已恢复",
      stats: {
        peerId: "broadcaster-2",
        videoWidth: 1080,
        videoHeight: 1920
      }
    });
  });

  it("ignores a stale answer that arrives after the broadcaster peer is already stable", async () => {
    const client = new LiveClient({
      role: "broadcaster",
      roomId: "room001",
      localStream: fakeStream(),
      onStatus: vi.fn()
    });

    client.start();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "viewer-ready", roomId: "room001", peerId: "viewer-1" })
    });
    await flushPromises();
    const peer = FakePeerConnection.instances[0];
    peer.signalingState = "stable";

    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "answer", roomId: "room001", peerId: "viewer-1", sdp: { type: "answer", sdp: "v=0" } })
    });
    await flushPromises();

    expect(peer.remoteDescriptionCalls).toBe(0);
  });
});

async function flushPromises() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function fakeStream() {
  return {
    getTracks: () => [{ kind: "video" }, { kind: "audio" }]
  } as unknown as MediaStream;
}

function fakeRemoteVideo(input: {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
}) {
  return {
    ...input,
    paused: false,
    ended: false,
    muted: false,
    defaultMuted: false,
    volume: 1,
    srcObject: null,
    play: vi.fn(async () => {}),
    load: vi.fn()
  };
}
