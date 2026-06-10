import { fetchRtcConfig, wsUrl } from "./api";
import {
  buildVideoSenderParameters,
  calculateBitrateBps,
  isVideoStalled,
  type BitrateSample,
  type LatencyMode,
  type VideoHealthSample
} from "./media";

type Role = "broadcaster" | "viewer";
type StatusCallback = (status: ClientStatus) => void;

export type ClientStatus = {
  connection: string;
  peerId?: string;
  bitrateBps?: number;
  fps?: number;
  path?: string;
  protocol?: string;
  resolution?: string;
  rttMs?: number;
  packetsLost?: number;
  jitterMs?: number;
  availableOutgoingKbps?: number;
  recovery?: string;
};

export class LiveClient {
  private role: Role;
  private roomId: string;
  private token?: string;
  private localStream?: MediaStream;
  private remoteVideo?: HTMLVideoElement;
  private ws?: WebSocket;
  private peers = new Map<string, RTCPeerConnection>();
  private peerHealth = new Map<string, VideoHealthSample>();
  private bitrateSamples = new Map<string, BitrateSample>();
  private recoveryTimers = new Map<string, number>();
  private status: ClientStatus = { connection: "等待" };
  private onStatus: StatusCallback;
  private onStats?: StatusCallback;
  private reconnectTimer?: number;
  private statsTimer?: number;
  private heartbeatTimer?: number;
  private forceRelay = false;
  private latencyMode: LatencyMode = "quality";
  private stopped = false;

  constructor(input: {
    role: Role;
    roomId: string;
    token?: string;
    localStream?: MediaStream;
    remoteVideo?: HTMLVideoElement;
    forceRelay?: boolean;
    latencyMode?: LatencyMode;
    onStatus: StatusCallback;
    onStats?: StatusCallback;
  }) {
    this.role = input.role;
    this.roomId = input.roomId;
    this.token = input.token;
    this.localStream = input.localStream;
    this.remoteVideo = input.remoteVideo;
    this.forceRelay = Boolean(input.forceRelay);
    this.latencyMode = input.latencyMode ?? "quality";
    this.onStatus = input.onStatus;
    this.onStats = input.onStats;
  }

  start() {
    this.stopped = false;
    this.connectSocket();
    this.statsTimer = window.setInterval(() => {
      void this.collectStats();
    }, 2000);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.ws?.close();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.peerHealth.clear();
    this.bitrateSamples.clear();
    for (const timer of this.recoveryTimers.values()) window.clearTimeout(timer);
    this.recoveryTimers.clear();
  }

  private connectSocket() {
    if (this.stopped) return;
    this.setStatus({ connection: "连接信令" });
    const socket = new WebSocket(wsUrl());
    this.ws = socket;

    socket.onopen = () => {
      this.setStatus({ connection: "信令已连接", recovery: undefined });
      this.send({ type: "join", roomId: this.roomId, role: this.role, token: this.token });
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      try {
        void this.handleSignal(JSON.parse(String(event.data)));
      } catch {
        this.setStatus({ connection: "信令消息错误" });
      }
    };

    socket.onclose = () => {
      if (this.stopped) return;
      if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
      this.setStatus({ connection: "信令重连中", recovery: "正在恢复直播" });
      this.reconnectTimer = window.setTimeout(() => this.connectSocket(), 1500);
    };
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: "heartbeat", roomId: this.roomId });
    }, 10_000);
  }

  private async handleSignal(message: any) {
    if (message.type === "joined") {
      this.setStatus({ peerId: message.peerId });
      return;
    }

    if (this.role === "broadcaster" && message.type === "viewer-ready") {
      await this.offerToViewer(message.peerId);
      return;
    }

    if (this.role === "viewer" && message.type === "offer") {
      await this.answerOffer(message.peerId, message.sdp);
      return;
    }

    if (message.type === "answer" && message.peerId) {
      await this.peers.get(message.peerId)?.setRemoteDescription(message.sdp);
      return;
    }

    if (message.type === "ice-candidate" && message.peerId && message.candidate) {
      await this.peers.get(message.peerId)?.addIceCandidate(message.candidate);
      return;
    }

    if (message.type === "restart-request" && this.role === "broadcaster") {
      await this.offerToViewer(message.peerId);
    }
  }

  private async createPeer(peerId: string) {
    this.clearRecoveryTimer(peerId);
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);
    this.peerHealth.delete(peerId);
    this.bitrateSamples.delete(peerId);

    const rtcConfig = await fetchRtcConfig(this.forceRelay);
    const pc = new RTCPeerConnection(rtcConfig);
    this.peers.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ type: "ice-candidate", roomId: this.roomId, targetPeerId: peerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      this.setStatus({ connection: pc.connectionState });
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.recoverPeer(peerId, pc);
      }
    };

    if (this.role === "viewer") {
      pc.ontrack = (event) => {
        if (this.remoteVideo) {
          this.remoteVideo.srcObject = event.streams[0];
          void this.remoteVideo.play().catch(() => {});
        }
      };
    } else if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === "video") {
          track.contentHint = this.latencyMode === "low-latency" ? "motion" : "detail";
          void tuneVideoSender(sender, this.latencyMode);
        }
      }
    }

    return pc;
  }

  private async offerToViewer(peerId: string) {
    const pc = await this.createPeer(peerId);
    await this.sendOffer(peerId, pc);
  }

  private async sendOffer(peerId: string, pc: RTCPeerConnection, options?: RTCOfferOptions) {
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    this.send({ type: "offer", roomId: this.roomId, targetPeerId: peerId, sdp: pc.localDescription });
  }

  private async answerOffer(peerId: string, sdp: RTCSessionDescriptionInit) {
    const pc = await this.createPeer(peerId);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ type: "answer", roomId: this.roomId, targetPeerId: peerId, sdp: pc.localDescription });
  }

  private recoverPeer(peerId: string, pc: RTCPeerConnection) {
    this.setStatus({ recovery: "正在恢复直播" });
    if (typeof pc.restartIce === "function") pc.restartIce();
    if (this.role === "viewer") {
      this.send({ type: "restart-request", roomId: this.roomId, targetPeerId: peerId, reason: "peer-unhealthy" });
    } else {
      void this.sendOffer(peerId, pc, { iceRestart: true });
    }

    if (this.recoveryTimers.has(peerId)) return;
    const timer = window.setTimeout(() => {
      this.recoveryTimers.delete(peerId);
      if (this.peers.get(peerId) !== pc) return;
      pc.close();
      this.peers.delete(peerId);
      this.peerHealth.delete(peerId);
      this.bitrateSamples.delete(peerId);
      if (this.role === "broadcaster") {
        void this.offerToViewer(peerId);
      } else {
        this.send({ type: "restart-request", roomId: this.roomId, targetPeerId: peerId, reason: "rebuild-timeout" });
      }
    }, 5000);
    this.recoveryTimers.set(peerId, timer);
  }

  private async collectStats() {
    for (const [peerId, pc] of this.peers.entries()) {
      const stats = await pc.getStats();
      let framesDecoded = 0;
      let bytesReceived = 0;
      let mediaBytes = 0;
      let fps: number | undefined;
      let resolution: string | undefined;
      let path: string | undefined;
      let protocol: string | undefined;
      let packetsLost: number | undefined;
      let jitterMs: number | undefined;
      let rttMs: number | undefined;
      let availableOutgoingKbps: number | undefined;
      let selectedPair: any;
      const candidates = new Map<string, any>();

      stats.forEach((report: any) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          framesDecoded = report.framesDecoded ?? framesDecoded;
          bytesReceived = report.bytesReceived ?? bytesReceived;
          mediaBytes = bytesReceived;
          fps = report.framesPerSecond ?? fps;
          if (report.frameWidth && report.frameHeight) resolution = `${report.frameWidth}x${report.frameHeight}`;
          packetsLost = report.packetsLost ?? packetsLost;
          if (report.jitter != null) jitterMs = Math.round(report.jitter * 1000);
        }
        if (report.type === "outbound-rtp" && report.kind === "video") {
          mediaBytes = report.bytesSent ?? mediaBytes;
          fps = report.framesPerSecond ?? fps;
          if (report.frameWidth && report.frameHeight) resolution = `${report.frameWidth}x${report.frameHeight}`;
          packetsLost = report.packetsLost ?? packetsLost;
        }
        if (report.type === "candidate-pair" && (report.nominated || report.selected)) {
          selectedPair = report;
          if (report.currentRoundTripTime != null) rttMs = Math.round(report.currentRoundTripTime * 1000);
          if (report.availableOutgoingBitrate != null) {
            availableOutgoingKbps = Math.round(report.availableOutgoingBitrate / 1024);
          }
        }
        if ((report.type === "local-candidate" || report.type === "remote-candidate") && report.id) {
          candidates.set(report.id, report);
        }
      });

      const localCandidate = selectedPair?.localCandidateId ? candidates.get(selectedPair.localCandidateId) : undefined;
      const remoteCandidate = selectedPair?.remoteCandidateId ? candidates.get(selectedPair.remoteCandidateId) : undefined;
      if (localCandidate?.candidateType === "relay" || remoteCandidate?.candidateType === "relay") {
        path = "TURN";
      }
      protocol = localCandidate?.relayProtocol ?? localCandidate?.protocol ?? protocol;

      const current = { framesDecoded, bytesReceived, checkedAt: Date.now() };
      if (this.role === "viewer" && isVideoStalled({
        previous: this.peerHealth.get(peerId) ?? null,
        current,
        thresholdMs: 5000
      })) {
        this.recoverPeer(peerId, pc);
      }
      this.peerHealth.set(peerId, current);
      const bitrateSample = { bytes: mediaBytes, checkedAt: current.checkedAt };
      const bitrateBps = calculateBitrateBps({
        previous: this.bitrateSamples.get(peerId) ?? null,
        current: bitrateSample
      });
      this.bitrateSamples.set(peerId, bitrateSample);
      const nextStatus = this.setStatus({
        bitrateBps,
        fps,
        path: path ?? "DIRECT",
        protocol,
        resolution,
        rttMs,
        packetsLost,
        jitterMs,
        availableOutgoingKbps
      });
      this.onStats?.(nextStatus);
    }
  }

  private clearRecoveryTimer(peerId: string) {
    const timer = this.recoveryTimers.get(peerId);
    if (timer) window.clearTimeout(timer);
    this.recoveryTimers.delete(peerId);
  }

  private send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private setStatus(partial: Partial<ClientStatus>) {
    this.status = { ...this.status, ...partial };
    this.onStatus(this.status);
    return this.status;
  }
}

async function tuneVideoSender(sender: RTCRtpSender, latencyMode: LatencyMode) {
  const parameters = sender.getParameters();
  await sender.setParameters(buildVideoSenderParameters(parameters, latencyMode) as RTCRtpSendParameters);
}
