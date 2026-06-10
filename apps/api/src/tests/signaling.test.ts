import { describe, expect, it } from "vitest";
import { SignalingHub, type SignalSocket } from "../signaling.js";

function socketPair() {
  const sent: string[] = [];
  const socket: SignalSocket = {
    readyState: 1,
    send(message) {
      sent.push(String(message));
    }
  };
  return { socket, sent };
}

describe("SignalingHub", () => {
  it("rejects unauthorized broadcaster joins", async () => {
    const hub = new SignalingHub({
      authorizeBroadcaster: async () => false
    });
    const broadcaster = socketPair();

    await hub.route(broadcaster.socket, {
      type: "join",
      roomId: "room001",
      role: "broadcaster",
      token: "bad-token"
    });

    expect(broadcaster.sent.at(-1)).toContain('"unauthorized"');
    expect(hub.roomPresence("room001").status).toBe("offline");
  });

  it("allows authorized broadcaster joins", async () => {
    const hub = new SignalingHub({
      authorizeBroadcaster: async (roomId, token) => roomId === "room001" && token === "good-token"
    });
    const broadcaster = socketPair();

    await hub.route(broadcaster.socket, {
      type: "join",
      roomId: "room001",
      role: "broadcaster",
      token: "good-token"
    });

    expect(hub.roomPresence("room001").status).toBe("live");
  });

  it("notifies a broadcaster about viewers that were waiting first", () => {
    const hub = new SignalingHub();
    const viewer = socketPair();
    const broadcaster = socketPair();

    const viewerId = hub.join("room001", "viewer", viewer.socket);
    hub.join("room001", "broadcaster", broadcaster.socket);

    expect(broadcaster.sent.some((message) =>
      message.includes('"viewer-ready"') && message.includes(viewerId)
    )).toBe(true);
  });

  it("does not force existing viewers to renegotiate when a broadcaster reconnects quickly", () => {
    const hub = new SignalingHub({ offlineGraceMs: 30_000 });
    const viewer = socketPair();
    const firstBroadcaster = socketPair();
    const secondBroadcaster = socketPair();

    hub.join("room001", "viewer", viewer.socket, 1_000);
    hub.join("room001", "broadcaster", firstBroadcaster.socket, 2_000);
    hub.leave(firstBroadcaster.socket, 3_000);
    hub.join("room001", "broadcaster", secondBroadcaster.socket, 4_000);

    expect(secondBroadcaster.sent.some((message) => message.includes('"viewer-ready"'))).toBe(false);
  });

  it("routes targeted offers and answers between peers", () => {
    const hub = new SignalingHub();
    const viewer = socketPair();
    const broadcaster = socketPair();

    const viewerId = hub.join("room001", "viewer", viewer.socket);
    const broadcasterId = hub.join("room001", "broadcaster", broadcaster.socket);

    hub.route(broadcaster.socket, {
      type: "offer",
      roomId: "room001",
      targetPeerId: viewerId,
      sdp: { type: "offer", sdp: "v=0" }
    });

    hub.route(viewer.socket, {
      type: "answer",
      roomId: "room001",
      targetPeerId: broadcasterId,
      sdp: { type: "answer", sdp: "v=0" }
    });

    expect(viewer.sent.at(-1)).toContain('"offer"');
    expect(broadcaster.sent.at(-1)).toContain('"answer"');
  });

  it("consumes heartbeats without broadcasting them to room peers", async () => {
    const hub = new SignalingHub();
    const viewer = socketPair();
    const broadcaster = socketPair();

    hub.join("room001", "viewer", viewer.socket);
    hub.join("room001", "broadcaster", broadcaster.socket);
    const viewerMessageCount = viewer.sent.length;
    const broadcasterMessageCount = broadcaster.sent.length;

    await hub.route(viewer.socket, {
      type: "heartbeat",
      roomId: "room001"
    });

    expect(viewer.sent).toHaveLength(viewerMessageCount);
    expect(broadcaster.sent).toHaveLength(broadcasterMessageCount);
  });

  it("keeps a room live for a short grace window after broadcaster disconnects", () => {
    const hub = new SignalingHub({ offlineGraceMs: 30_000 });
    const broadcaster = socketPair();

    hub.join("room001", "broadcaster", broadcaster.socket);
    hub.leave(broadcaster.socket, 1_000);

    expect(hub.roomPresence("room001", 10_000).status).toBe("recovering");
    expect(hub.roomPresence("room001", 40_000).status).toBe("offline");
  });
});
