export type User = {
  id: string;
  roomId: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
};

export type AdminUser = User & {
  presence: {
    broadcasters: number;
    viewers: number;
    status: string;
  };
};

export type RtcConfig = RTCConfiguration & {
  iceTransportPolicy: "all" | "relay";
};

export type ClientSettings = {
  lowLatencyDefault: boolean;
};

export function getToken(key: "adminToken" | "userToken") {
  return localStorage.getItem(key) ?? "";
}

export function setToken(key: "adminToken" | "userToken", token: string) {
  localStorage.setItem(key, token);
}

export async function apiJson<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? "请求失败");
  }
  return data as T;
}

export async function loginUser(roomId: string, password: string) {
  return apiJson<{ token: string; user: User }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ roomId, password })
  });
}

export async function fetchMe(token: string) {
  return apiJson<{ user: User }>("/api/me", { token });
}

export async function loginAdmin(username: string, password: string) {
  return apiJson<{ token: string }>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function updateAdminUser(input: {
  roomId: string;
  token: string;
  displayName?: string;
  password?: string;
  enabled?: boolean;
}) {
  return apiJson<{ user: User }>(`/api/admin/users/${encodeURIComponent(input.roomId)}`, {
    method: "PATCH",
    token: input.token,
    body: JSON.stringify({
      displayName: input.displayName,
      password: input.password,
      enabled: input.enabled
    })
  });
}

export async function deleteAdminUser(roomId: string, token: string) {
  return apiJson<void>(`/api/admin/users/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
    token
  });
}

export async function fetchRtcConfig(forceRelay = false) {
  return apiJson<RtcConfig>(`/api/rtc-config${forceRelay ? "?relay=1" : ""}`);
}

export async function fetchClientSettings() {
  return apiJson<ClientSettings>("/api/client-settings");
}

export async function postRoomEvent(input: {
  roomId: string;
  token?: string;
  type: string;
  role: "broadcaster" | "viewer";
  detail: string;
  stats?: unknown;
}) {
  const path = input.role === "viewer" ? `/api/rooms/${encodeURIComponent(input.roomId)}/events` : "/api/events";
  return apiJson(path, {
    method: "POST",
    token: input.token,
    body: JSON.stringify({
      type: input.type,
      role: input.role,
      detail: input.detail,
      stats: input.stats
    })
  });
}

export function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/signaling`;
}
