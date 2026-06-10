import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { verifyToken } from "./auth.js";
import { applyEnvironmentSettings } from "./server-config.js";
import { SignalingHub, type SignalMessage } from "./signaling.js";
import { createFileStore } from "./store.js";

const port = Number(process.env.PORT ?? 4200);
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? "./data");
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123456";

const store = await createFileStore(dataDir);
await store.ensureAdmin(adminUsername, adminPassword);
await applyEnvironmentSettings(store, process.env);

const hub = new SignalingHub({
  authorizeBroadcaster: async (roomId, token) => {
    if (!token) return false;
    const payload = verifyToken(token, jwtSecret);
    if (!payload || payload.role !== "user" || payload.roomId !== roomId) return false;
    const user = await store.getUserByRoomId(roomId);
    return Boolean(user?.enabled);
  }
});

const { app } = createApp({
  store,
  jwtSecret,
  getRoomPresence: (roomId) => hub.roomPresence(roomId)
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/signaling" });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message: SignalMessage;
    try {
      message = JSON.parse(String(raw)) as SignalMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "信令消息格式错误" }));
      return;
    }

    void hub.route(socket, message).catch(() => {
      socket.send(JSON.stringify({ type: "error", message: "信令处理失败" }));
    });
  });

  socket.on("close", () => {
    hub.leave(socket);
  });
});

server.listen(port, () => {
  console.log(`WebTRC 2.0 API listening on http://localhost:${port}`);
});
