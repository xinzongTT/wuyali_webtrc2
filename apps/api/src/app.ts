import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { signToken, verifyToken, type TokenPayload } from "./auth.js";
import { buildRtcConfig } from "./rtc-config.js";
import type { AppStore } from "./store.js";

type AuthedRequest = Request & { auth?: TokenPayload };

export function createApp(options: {
  store: AppStore;
  jwtSecret: string;
  getRoomPresence?: (roomId: string) => { broadcasters: number; viewers: number; status: string };
}) {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "webtrc2.0" });
  });

  app.post("/api/admin/login", async (req, res) => {
    const parsed = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_admin_login" });
    const valid = await options.store.verifyAdmin(parsed.data.username, parsed.data.password);
    if (!valid) return res.status(401).json({ error: "invalid_admin_login" });
    res.json({ token: signToken({ sub: parsed.data.username, role: "admin" }, options.jwtSecret) });
  });

  app.post("/api/login", async (req, res) => {
    const parsed = z.object({ roomId: roomIdSchema, password: z.string().min(6) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_user_login" });
    const user = await options.store.verifyUser(parsed.data.roomId, parsed.data.password);
    if (!user) return res.status(401).json({ error: "invalid_user_login" });
    res.json({
      token: signToken({ sub: user.id, role: "user", roomId: user.roomId }, options.jwtSecret),
      user: publicUser(user)
    });
  });

  app.get("/api/me", requireAuth("user"), async (req: AuthedRequest, res) => {
    const user = await options.store.getUserByRoomId(req.auth?.roomId ?? "");
    if (!user) return res.status(404).json({ error: "user_not_found" });
    res.json({ user: publicUser(user) });
  });

  app.get("/api/rtc-config", async (req, res) => {
    const settings = await options.store.getSettings();
    const forceRelay = req.query.relay === "1" || req.query.relay === "true" || settings.forceRelay;
    res.json(buildRtcConfig({ ...settings, forceRelay }));
  });

  app.get("/api/client-settings", async (_req, res) => {
    const settings = await options.store.getSettings();
    res.json({ lowLatencyDefault: settings.lowLatencyDefault });
  });

  app.post("/api/events", requireAuth("user"), async (req: AuthedRequest, res) => {
    const parsed = z.object({
      type: z.string().min(1).max(64),
      role: z.enum(["broadcaster", "viewer"]),
      detail: z.string().max(256).default(""),
      stats: z.unknown().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_event" });
    const event = await options.store.recordRoomEvent({
      roomId: req.auth?.roomId ?? "",
      type: parsed.data.type,
      role: parsed.data.role,
      detail: parsed.data.detail,
      stats: parsed.data.stats ?? null
    });
    res.status(201).json({ event });
  });

  app.post("/api/rooms/:roomId/events", async (req, res) => {
    const roomId = roomIdSchema.safeParse(req.params.roomId);
    const parsed = z.object({
      type: z.string().min(1).max(64),
      role: z.literal("viewer"),
      detail: z.string().max(256).default(""),
      stats: z.unknown().optional()
    }).safeParse(req.body);
    if (!roomId.success || !parsed.success) return res.status(400).json({ error: "invalid_event" });
    const user = await options.store.getUserByRoomId(roomId.data);
    if (!user) return res.status(404).json({ error: "room_not_found" });
    const event = await options.store.recordRoomEvent({
      roomId: roomId.data,
      type: parsed.data.type,
      role: parsed.data.role,
      detail: parsed.data.detail,
      stats: parsed.data.stats ?? null
    });
    res.status(201).json({ event });
  });

  app.get("/api/admin/users", requireAuth("admin"), async (_req, res) => {
    const users = await options.store.listUsers();
    res.json({
      users: users.map((user) => ({
        ...publicUser(user),
        presence: options.getRoomPresence?.(user.roomId) ?? { broadcasters: 0, viewers: 0, status: "offline" }
      }))
    });
  });

  app.post("/api/admin/users", requireAuth("admin"), async (req, res) => {
    const parsed = z.object({
      roomId: roomIdSchema,
      password: z.string().min(6),
      displayName: z.string().max(64).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_user" });
    try {
      const user = await options.store.createUser(parsed.data);
      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error instanceof Error && error.message === "room_exists") {
        return res.status(409).json({ error: "room_exists" });
      }
      throw error;
    }
  });

  app.get("/api/admin/rooms/:roomId/diagnostics", requireAuth("admin"), async (req, res) => {
    const events = await options.store.recentRoomEvents(req.params.roomId, 50);
    res.json({
      roomId: req.params.roomId,
      presence: options.getRoomPresence?.(req.params.roomId) ?? { broadcasters: 0, viewers: 0, status: "offline" },
      events
    });
  });

  app.get("/api/admin/settings", requireAuth("admin"), async (_req, res) => {
    res.json(await options.store.getSettings());
  });

  app.put("/api/admin/settings", requireAuth("admin"), async (req, res) => {
    const parsed = z.object({
      stunUrls: z.string().optional(),
      turnUrls: z.string().optional(),
      turnUsername: z.string().optional(),
      turnCredential: z.string().optional(),
      forceRelay: z.boolean().optional(),
      lowLatencyDefault: z.boolean().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_settings" });
    res.json(await options.store.updateSettings(parsed.data));
  });

  function requireAuth(role: "admin" | "user") {
    return (req: AuthedRequest, res: Response, next: NextFunction) => {
      const header = req.header("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      const payload = token ? verifyToken(token, options.jwtSecret) : null;
      if (!payload || payload.role !== role) return res.status(401).json({ error: "unauthorized" });
      req.auth = payload;
      next();
    };
  }

  return { app };
}

const roomIdSchema = z.string().min(3).max(64).regex(/^[a-z0-9_-]+$/);

function publicUser(user: { id: string; roomId: string; displayName: string; enabled: boolean; createdAt: string }) {
  return {
    id: user.id,
    roomId: user.roomId,
    displayName: user.displayName,
    enabled: user.enabled,
    createdAt: user.createdAt
  };
}
