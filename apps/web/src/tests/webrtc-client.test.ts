import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveClient } from "../webrtc-client";

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
  closed = false;
  restartIceCalls = 0;
  stats = new Map<string, any>();

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
  }

  async setRemoteDescription(_description: RTCSessionDescriptionInit) {}
  async addIceCandidate(_candidate: unknown) {}
  addTrack(_track: MediaStreamTrack, _stream: MediaStream) {
    return { getParameters: () => ({}), setParameters: vi.fn() } as unknown as RTCRtpSender;
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

    const firstPeer = FakePeerConnection.instances[0];
    firstPeer.connectionState = "disconnected";
    firstPeer.onconnectionstatechange?.();
    await flushPromises();

    expect(firstPeer.restartIceCalls).toBe(1);
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
