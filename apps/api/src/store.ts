import fs from "node:fs/promises";
import path from "node:path";
import { hashPassword, verifyPassword } from "./auth.js";

export type UserRecord = {
  id: string;
  roomId: string;
  displayName: string;
  passwordHash: string;
  enabled: boolean;
  createdAt: string;
};

export type AdminRecord = {
  username: string;
  passwordHash: string;
};

export type RoomEventRecord = {
  id: string;
  roomId: string;
  type: string;
  role: "broadcaster" | "viewer";
  detail: string;
  stats: unknown;
  createdAt: string;
};

export type SystemSettings = {
  stunUrls: string;
  turnUrls: string;
  turnUsername: string;
  turnCredential: string;
  forceRelay: boolean;
  lowLatencyDefault: boolean;
};

export type AppStore = {
  ensureAdmin(username: string, password: string): Promise<void>;
  verifyAdmin(username: string, password: string): Promise<boolean>;
  createUser(input: { roomId: string; password: string; displayName?: string }): Promise<UserRecord>;
  updateUser(roomId: string, input: { displayName?: string; password?: string; enabled?: boolean }): Promise<UserRecord | null>;
  deleteUser(roomId: string): Promise<boolean>;
  getUserByRoomId(roomId: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  verifyUser(roomId: string, password: string): Promise<UserRecord | null>;
  recordRoomEvent(input: Omit<RoomEventRecord, "id" | "createdAt">): Promise<RoomEventRecord>;
  recentRoomEvents(roomId: string, limit: number): Promise<RoomEventRecord[]>;
  getSettings(): Promise<SystemSettings>;
  updateSettings(settings: Partial<SystemSettings>): Promise<SystemSettings>;
  close(): Promise<void>;
};

type DataShape = {
  admins: AdminRecord[];
  users: UserRecord[];
  events: RoomEventRecord[];
  settings: SystemSettings;
};

const defaultSettings: SystemSettings = {
  stunUrls: "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478",
  turnUrls: "",
  turnUsername: "",
  turnCredential: "",
  forceRelay: false,
  lowLatencyDefault: false
};

export function createMemoryStore(initial?: Partial<DataShape>): AppStore {
  let data: DataShape = {
    admins: initial?.admins ?? [],
    users: initial?.users ?? [],
    events: initial?.events ?? [],
    settings: { ...defaultSettings, ...initial?.settings }
  };
  return createStoreAdapter(
    () => data,
    async (next) => {
      data = next;
    }
  );
}

export async function createFileStore(dataDir: string): Promise<AppStore> {
  await fs.mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "webtrc2-data.json");
  let data: DataShape;

  try {
    data = JSON.parse(await fs.readFile(filePath, "utf8")) as DataShape;
    data = { ...data, settings: { ...defaultSettings, ...data.settings } };
  } catch {
    data = { admins: [], users: [], events: [], settings: defaultSettings };
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  return createStoreAdapter(
    () => data,
    async (next) => {
      data = next;
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    }
  );
}

function createStoreAdapter(read: () => DataShape, write: (next: DataShape) => Promise<void>): AppStore {
  return {
    async ensureAdmin(username, password) {
      const data = read();
      if (data.admins.some((admin) => admin.username === username)) return;
      await write({
        ...data,
        admins: [...data.admins, { username, passwordHash: hashPassword(password) }]
      });
    },

    async verifyAdmin(username, password) {
      const admin = read().admins.find((entry) => entry.username === username);
      return Boolean(admin && verifyPassword(password, admin.passwordHash));
    },

    async createUser(input) {
      const data = read();
      if (data.users.some((user) => user.roomId === input.roomId)) {
        throw new Error("room_exists");
      }
      const user: UserRecord = {
        id: cryptoRandomId(),
        roomId: input.roomId,
        displayName: input.displayName?.trim() || input.roomId,
        passwordHash: hashPassword(input.password),
        enabled: true,
        createdAt: new Date().toISOString()
      };
      await write({ ...data, users: [...data.users, user] });
      return user;
    },

    async updateUser(roomId, input) {
      const data = read();
      let updated: UserRecord | null = null;
      const users = data.users.map((user) => {
        if (user.roomId !== roomId) return user;
        updated = {
          ...user,
          displayName: input.displayName?.trim() || user.displayName,
          passwordHash: input.password ? hashPassword(input.password) : user.passwordHash,
          enabled: typeof input.enabled === "boolean" ? input.enabled : user.enabled
        };
        return updated;
      });
      if (!updated) return null;
      await write({ ...data, users });
      return updated;
    },

    async deleteUser(roomId) {
      const data = read();
      const users = data.users.filter((user) => user.roomId !== roomId);
      if (users.length === data.users.length) return false;
      await write({
        ...data,
        users,
        events: data.events.filter((event) => event.roomId !== roomId)
      });
      return true;
    },

    async getUserByRoomId(roomId) {
      return read().users.find((user) => user.roomId === roomId) ?? null;
    },

    async listUsers() {
      return [...read().users].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async verifyUser(roomId, password) {
      const user = read().users.find((entry) => entry.roomId === roomId);
      if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) return null;
      return user;
    },

    async recordRoomEvent(input) {
      const data = read();
      const event: RoomEventRecord = {
        ...input,
        id: cryptoRandomId(),
        createdAt: new Date().toISOString()
      };
      await write({ ...data, events: [event, ...data.events].slice(0, 1000) });
      return event;
    },

    async recentRoomEvents(roomId, limit) {
      return read().events.filter((event) => event.roomId === roomId).slice(0, limit);
    },

    async getSettings() {
      return read().settings;
    },

    async updateSettings(settings) {
      const data = read();
      const next = { ...data.settings, ...settings };
      await write({ ...data, settings: next });
      return next;
    },

    async close() {}
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
