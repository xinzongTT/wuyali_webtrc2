export type SignalPeerRole = "broadcaster" | "viewer";

export type SignalSocket = {
  readyState: number;
  send(message: string): void;
};

export type SignalMessage =
  | { type: "join"; roomId: string; role: SignalPeerRole; token?: string }
  | { type: "viewer-ready"; roomId: string; targetPeerId?: string; peerId?: string }
  | { type: "broadcaster-ready"; roomId: string; targetPeerId?: string; peerId?: string }
  | { type: "offer"; roomId: string; targetPeerId?: string; peerId?: string; sdp: unknown }
  | { type: "answer"; roomId: string; targetPeerId?: string; peerId?: string; sdp: unknown }
  | { type: "ice-candidate"; roomId: string; targetPeerId?: string; peerId?: string; candidate: unknown }
  | { type: "restart-request"; roomId: string; targetPeerId?: string; peerId?: string; reason?: string }
  | { type: "heartbeat"; roomId: string };

type Peer = {
  id: string;
  roomId: string;
  role: SignalPeerRole;
  socket: SignalSocket;
  joinedAt: number;
};

type AuthorizeBroadcaster = (roomId: string, token: string | undefined) => boolean | Promise<boolean>;

export class SignalingHub {
  private rooms = new Map<string, Map<string, Peer>>();
  private socketToPeer = new WeakMap<SignalSocket, Peer>();
  private lastBroadcasterLeftAt = new Map<string, number>();
  private nextId = 1;
  private offlineGraceMs: number;
  private authorizeBroadcaster?: AuthorizeBroadcaster;

  constructor(options: { offlineGraceMs?: number; authorizeBroadcaster?: AuthorizeBroadcaster } = {}) {
    this.offlineGraceMs = options.offlineGraceMs ?? 30_000;
    this.authorizeBroadcaster = options.authorizeBroadcaster;
  }

  join(roomId: string, role: SignalPeerRole, socket: SignalSocket, now = Date.now()) {
    const id = `${role}-${this.nextId++}`;
    const peer: Peer = { id, roomId, role, socket, joinedAt: now };
    const room = this.rooms.get(roomId) ?? new Map<string, Peer>();
    room.set(id, peer);
    this.rooms.set(roomId, room);
    this.socketToPeer.set(socket, peer);

    socket.send(JSON.stringify({ type: "joined", roomId, role, peerId: id, presence: this.roomPresence(roomId, now) }));

    if (role === "viewer") {
      this.broadcast(roomId, { type: "viewer-ready", roomId, peerId: id }, id, "broadcaster");
    } else {
      const leftAt = this.lastBroadcasterLeftAt.get(roomId);
      const isQuickReconnect = leftAt != null && now - leftAt <= this.offlineGraceMs;
      this.lastBroadcasterLeftAt.delete(roomId);
      if (!isQuickReconnect) {
        for (const existing of room.values()) {
          if (existing.role === "viewer") {
            socket.send(JSON.stringify({ type: "viewer-ready", roomId, peerId: existing.id }));
          }
        }
      }
      this.broadcast(roomId, { type: "broadcaster-ready", roomId, peerId: id }, id, "viewer");
    }
    this.broadcastRoomState(roomId, now);
    return id;
  }

  async route(sender: SignalSocket, message: SignalMessage) {
    if (message.type === "join") {
      if (message.role === "broadcaster" && this.authorizeBroadcaster) {
        const allowed = await this.authorizeBroadcaster(message.roomId, message.token);
        if (!allowed) {
          sender.send(JSON.stringify({ type: "error", code: "unauthorized", message: "未授权直播间" }));
          return;
        }
      }
      this.join(message.roomId, message.role, sender);
      return;
    }

    const peer = this.socketToPeer.get(sender);
    if (!peer || peer.roomId !== message.roomId) return;
    if (message.type === "heartbeat") return;
    const outbound = { ...message, peerId: peer.id };
    if ("targetPeerId" in message && message.targetPeerId) {
      this.sendToPeer(message.roomId, message.targetPeerId, outbound);
      return;
    }
    this.broadcast(message.roomId, outbound, peer.id);
  }

  leave(socket: SignalSocket, now = Date.now()) {
    const peer = this.socketToPeer.get(socket);
    if (!peer) return;
    const room = this.rooms.get(peer.roomId);
    room?.delete(peer.id);
    if (peer.role === "broadcaster") {
      this.lastBroadcasterLeftAt.set(peer.roomId, now);
    }
    this.broadcastRoomState(peer.roomId, now);
  }

  roomPresence(roomId: string, now = Date.now()) {
    const peers = [...(this.rooms.get(roomId)?.values() ?? [])];
    const broadcasters = peers.filter((peer) => peer.role === "broadcaster").length;
    const viewers = peers.filter((peer) => peer.role === "viewer").length;
    const leftAt = this.lastBroadcasterLeftAt.get(roomId);
    const recovering = broadcasters === 0 && leftAt != null && now - leftAt <= this.offlineGraceMs;
    return {
      broadcasters,
      viewers,
      status: broadcasters > 0 ? "live" : recovering ? "recovering" : "offline"
    };
  }

  private broadcast(roomId: string, message: unknown, exceptPeerId?: string, role?: SignalPeerRole) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const peer of room.values()) {
      if (peer.id === exceptPeerId) continue;
      if (role && peer.role !== role) continue;
      peer.socket.send(JSON.stringify(message));
    }
  }

  private sendToPeer(roomId: string, peerId: string, message: unknown) {
    this.rooms.get(roomId)?.get(peerId)?.socket.send(JSON.stringify(message));
  }

  private broadcastRoomState(roomId: string, now = Date.now()) {
    this.broadcast(roomId, { type: "room-state", roomId, presence: this.roomPresence(roomId, now) });
  }
}
