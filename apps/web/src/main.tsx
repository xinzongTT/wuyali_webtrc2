import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, AlertTriangle, Camera, LogOut, Mic, Monitor, Play, Plus, Radio, Settings, Shield, Square, Users } from "lucide-react";
import {
  apiJson,
  fetchClientSettings,
  getToken,
  loginAdmin,
  loginUser,
  postRoomEvent,
  setToken,
  type AdminUser,
  type User
} from "./api";
import { LiveClient, type ClientStatus, type RecoveryEvent } from "./webrtc-client";
import {
  audioLevelToMeterPercent,
  buildAudioConstraints,
  buildVideoConstraints,
  formatBitrate,
  formatHealthLabel,
  formatPathLabel,
  listMediaDevices,
  readTrackSettings
} from "./media";
import "./styles.css";

type DeviceState = {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
};

type SystemSettings = {
  stunUrls: string;
  turnUrls: string;
  turnUsername: string;
  turnCredential: string;
  forceRelay: boolean;
  lowLatencyDefault: boolean;
};

type DiagnosticEvent = {
  id: string;
  type: string;
  role: string;
  detail: string;
  stats?: unknown;
  createdAt: string;
};

function App() {
  const path = window.location.pathname;
  if (path.startsWith("/admin/login")) return <AdminLogin />;
  if (path.startsWith("/admin")) return <AdminPage />;
  if (path.startsWith("/view/")) return <ViewerPage roomId={decodeURIComponent(path.split("/").at(-1) ?? "")} />;
  return <LivePage />;
}

function AdminLogin() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await loginAdmin(username, password);
      setToken("adminToken", result.token);
      window.location.href = "/admin";
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  return (
    <AuthShell title="管理员后台" subtitle="创建账号、查看直播状态和 WebRTC 诊断">
      <form className="card auth-card" onSubmit={submit}>
        <label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit"><Shield size={16} />登录</button>
      </form>
    </AuthShell>
  );
}

function LivePage() {
  const [user, setUser] = useState<User | null>(null);
  const [roomId, setRoomId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<DeviceState>({ cameras: [], microphones: [] });
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [client, setClient] = useState<LiveClient | null>(null);
  const [status, setStatus] = useState<ClientStatus>({ connection: "未开启" });
  const [audioLevel, setAudioLevel] = useState(0);
  const [trackInfo, setTrackInfo] = useState("");
  const [lowLatency, setLowLatency] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterCleanupRef = useRef<() => void>();
  const streamRef = useRef<MediaStream | null>(null);
  const clientRef = useRef<LiveClient | null>(null);
  const statsUploadRef = useRef(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await loginUser(roomId, password);
      setToken("userToken", result.token);
      setUser(result.user);
      await refreshDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  async function refreshDevices() {
    const next = await listMediaDevices().catch(() => ({ cameras: [], microphones: [] }));
    setDevices(next);
  }

  async function openCamera() {
    clientRef.current?.stop();
    clientRef.current = null;
    meterCleanupRef.current?.();
    streamRef.current?.getTracks().forEach((track) => track.stop());

    const nextStream = await navigator.mediaDevices.getUserMedia({
      video: buildVideoConstraints(cameraId || undefined, lowLatency ? "low-latency" : "quality"),
      audio: buildAudioConstraints(navigator.userAgent, microphoneId || undefined, lowLatency ? "low-latency" : "quality")
    });

    streamRef.current = nextStream;
    setStream(nextStream);
    if (videoRef.current) videoRef.current.srcObject = nextStream;

    const settings = readTrackSettings(nextStream);
    setTrackInfo(`${settings.video?.width ?? "-"}x${settings.video?.height ?? "-"} · ${settings.video?.frameRate ?? "-"} fps`);
    meterCleanupRef.current = startAudioMeter(nextStream, setAudioLevel);
    setClient(null);
    setStatus({ connection: "未开启" });
    await refreshDevices();
  }

  async function startLive() {
    if (!user || !stream) return;
    const current = new LiveClient({
      role: "broadcaster",
      roomId: user.roomId,
      token: getToken("userToken"),
      localStream: stream,
      latencyMode: lowLatency ? "low-latency" : "quality",
      onStatus: setStatus,
      onStats: (nextStatus) => {
        if (Date.now() - statsUploadRef.current < 10000) return;
        statsUploadRef.current = Date.now();
        void postRoomEvent({
          roomId: user.roomId,
          token: getToken("userToken"),
          type: "rtc_stats",
          role: "broadcaster",
          detail: buildStatsDetail(nextStatus),
          stats: buildStatsPayload(nextStatus)
        }).catch(() => {});
      },
      onRecoveryEvent: (event) => {
        void postRecoveryEvent({
          roomId: user.roomId,
          token: getToken("userToken"),
          role: "broadcaster",
          event
        });
      }
    });
    current.start();
    clientRef.current = current;
    setClient(current);
    await postRoomEvent({
      roomId: user.roomId,
      token: getToken("userToken"),
      type: "registered_broadcaster",
      role: "broadcaster",
      detail: "开启直播",
      stats: { trackInfo }
    });
  }

  function stopLive() {
    clientRef.current?.stop();
    clientRef.current = null;
    setClient(null);
    setStatus({ connection: "已停止" });
  }

  useEffect(() => {
    void fetchClientSettings().then((next) => setLowLatency(next.lowLatencyDefault)).catch(() => {});
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      clientRef.current?.stop();
      meterCleanupRef.current?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  if (!user) {
    return (
      <AuthShell title="WebTRC 2.0" subtitle="输入直播间 ID 和密码，直接开启直播">
        <form className="card auth-card" onSubmit={submit}>
          <label>直播间 ID<input value={roomId} onChange={(e) => setRoomId(e.target.value.toLowerCase())} placeholder="xiaoyu" /></label>
          <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit"><Radio size={16} />进入开播页</button>
        </form>
      </AuthShell>
    );
  }

  return (
    <Shell title={user.displayName} subtitle={`直播间 ${user.roomId}`}>
      <section className="live-grid">
        <div className="preview-shell">
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="live-overlay top-left">
            <span className="badge inverse">{status.connection}</span>
            <span className="badge">{trackInfo || "等待摄像头"}</span>
          </div>
          <div className="live-overlay top-right">
            <span className="badge">{lowLatency ? "Low latency" : "Quality"}</span>
            <span className="badge">{formatBitrate(status.bitrateBps)}</span>
            <span className="badge">{formatPathLabel({ path: status.path, protocol: status.protocol, fps: status.fps })}</span>
            <span className="badge">{formatHealthLabel(status)}</span>
          </div>
          <div className="audio-meter">
            <Mic size={14} />
            <span><i style={{ width: `${audioLevel}%` }} /></span>
          </div>
        </div>

        <aside className="panel">
          <div className="field-row">
            <label>摄像头
              <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                <option value="">默认后置</option>
                {devices.cameras.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>
                ))}
              </select>
            </label>
            <label>麦克风
              <select value={microphoneId} onChange={(e) => setMicrophoneId(e.target.value)}>
                <option value="">默认麦克风</option>
                {devices.microphones.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <label className="check"><input type="checkbox" checked={lowLatency} onChange={(e) => setLowLatency(e.target.checked)} />Low latency</label>
            <button className="secondary" onClick={openCamera}><Camera size={16} />打开摄像头</button>
            {!client
              ? <button className="primary" onClick={startLive} disabled={!stream}><Play size={16} />开启直播</button>
              : <button className="danger" onClick={stopLive}><Square size={16} />停止直播</button>}
          </div>
          <CopyBox label="OBS 接收地址" value={`${window.location.origin}/view/${user.roomId}`} />
        </aside>
      </section>
    </Shell>
  );
}

function ViewerPage({ roomId }: { roomId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<ClientStatus>({ connection: "等待直播" });
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const statsUploadRef = useRef(0);
  const showDebug = new URLSearchParams(window.location.search).get("debug") === "1";

  useEffect(() => {
    if (!videoRef.current) return;
    const current = new LiveClient({
      role: "viewer",
      roomId,
      remoteVideo: videoRef.current,
      onStatus: setStatus,
      onStats: (nextStatus) => {
        if (Date.now() - statsUploadRef.current < 10000) return;
        statsUploadRef.current = Date.now();
        void postRoomEvent({
          roomId,
          type: "rtc_stats",
          role: "viewer",
          detail: buildStatsDetail(nextStatus),
          stats: buildStatsPayload(nextStatus)
        }).catch(() => {});
      },
      onRecoveryEvent: (event) => {
        void postRecoveryEvent({
          roomId,
          role: "viewer",
          event
        });
      }
    });
    current.start();
    return () => current.stop();
  }, [roomId]);

  return (
    <main className="viewer-page">
      <video ref={videoRef} className={fit} playsInline autoPlay controls />
      <div className="viewer-status" data-visible={showDebug}>
        <span className="badge inverse">{status.connection}</span>
        <span className="badge">{status.resolution || "等待分辨率"}</span>
        <span className="badge">{formatBitrate(status.bitrateBps)}</span>
        <span className="badge">{formatPathLabel({ path: status.path, protocol: status.protocol, fps: status.fps })}</span>
        <span className="badge">{formatHealthLabel(status)}</span>
        <button className="ghost" onClick={() => setFit(fit === "contain" ? "cover" : "contain")}><Monitor size={14} />{fit}</button>
      </div>
    </main>
  );
}

function AdminPage() {
  const token = getToken("adminToken");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roomId, setRoomId] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [error, setError] = useState("");

  async function load() {
    if (!token) {
      window.location.href = "/admin/login";
      return;
    }
    const [userResult, settingsResult] = await Promise.all([
      apiJson<{ users: AdminUser[] }>("/api/admin/users", { token }),
      apiJson<SystemSettings>("/api/admin/settings", { token })
    ]);
    setUsers(userResult.users);
    setSettings(settingsResult);
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await apiJson("/api/admin/users", {
        method: "POST",
        token,
        body: JSON.stringify({ roomId, password, displayName })
      });
      setRoomId("");
      setPassword("");
      setDisplayName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  }

  async function openDiagnostics(nextRoomId: string) {
    setSelectedRoom(nextRoomId);
    const result = await apiJson<{ events: DiagnosticEvent[] }>(`/api/admin/rooms/${nextRoomId}/diagnostics`, { token });
    setEvents(result.events);
  }

  async function saveSettings() {
    if (!settings) return;
    await apiJson("/api/admin/settings", {
      method: "PUT",
      token,
      body: JSON.stringify(settings)
    });
    await load();
  }

  useEffect(() => { void load(); }, []);

  const liveUsers = users.filter((user) => user.presence.status === "live").length;
  const totalViewers = users.reduce((sum, user) => sum + user.presence.viewers, 0);
  const turnReady = Boolean(settings?.turnUrls.trim());
  const outageEvents = events.filter(isOutageEvent);

  return (
    <Shell title="管理员后台" subtitle="账号、直播状态、TURN 和诊断">
      <section className="admin-console">
        <div className="admin-summary">
          <div>
            <span className="metric-label">用户</span>
            <strong>{users.length}</strong>
          </div>
          <div>
            <span className="metric-label">直播中</span>
            <strong>{liveUsers}</strong>
          </div>
          <div>
            <span className="metric-label">接收端</span>
            <strong>{totalViewers}</strong>
          </div>
          <div>
            <span className="metric-label">TURN</span>
            <strong>{turnReady ? "已配置" : "未配置"}</strong>
          </div>
        </div>

        <section className="admin-layout">
          <aside className="admin-side">
            <form className="card admin-card" onSubmit={createUser}>
              <div className="section-title">
                <h2><Plus size={17} />创建用户</h2>
                <span>房间 ID 即 OBS 接收地址 ID</span>
              </div>
              <label>直播间 ID<input value={roomId} onChange={(e) => setRoomId(e.target.value.toLowerCase())} placeholder="xiaoyu" /></label>
              <label>显示名称<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="可选" /></label>
              <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              {error && <p className="error">{error}</p>}
              <button className="primary" type="submit"><Plus size={16} />创建用户</button>
            </form>

            <div className="card admin-card">
              <div className="section-title">
                <h2><Settings size={17} />WebRTC 设置</h2>
                <span>TURN 支持多个 URL，用逗号分隔</span>
              </div>
              {settings && (
                <div className="settings-grid">
                  <label>STUN<input value={settings.stunUrls} onChange={(e) => setSettings({ ...settings, stunUrls: e.target.value })} /></label>
                  <label>TURN URLs<input value={settings.turnUrls} onChange={(e) => setSettings({ ...settings, turnUrls: e.target.value })} placeholder="turn:host:3478?transport=udp" /></label>
                  <div className="two-fields">
                    <label>TURN 用户名<input value={settings.turnUsername} onChange={(e) => setSettings({ ...settings, turnUsername: e.target.value })} /></label>
                    <label>TURN 密码<input value={settings.turnCredential} onChange={(e) => setSettings({ ...settings, turnCredential: e.target.value })} /></label>
                  </div>
                  <div className="switch-row">
                    <label className="check"><input type="checkbox" checked={settings.forceRelay} onChange={(e) => setSettings({ ...settings, forceRelay: e.target.checked })} />强制 TURN 诊断</label>
                    <label className="check"><input type="checkbox" checked={settings.lowLatencyDefault} onChange={(e) => setSettings({ ...settings, lowLatencyDefault: e.target.checked })} />默认低延迟</label>
                  </div>
                  <button className="primary" onClick={saveSettings}><Settings size={16} />保存设置</button>
                </div>
              )}
            </div>
          </aside>

          <main className="admin-main">
            <div className="card admin-card">
              <div className="section-title horizontal">
                <h2><Users size={17} />用户列表</h2>
                <span>点击用户查看最近诊断</span>
              </div>
              <div className="table admin-table">
                <div className="table-head">
                  <span>名称</span>
                  <span>房间 ID</span>
                  <span>状态</span>
                  <span>接收端</span>
                </div>
                {users.map((user) => (
                  <button
                    key={user.id}
                    className={`table-row ${selectedRoom === user.roomId ? "selected" : ""}`}
                    onClick={() => openDiagnostics(user.roomId)}
                  >
                    <span>{user.displayName}</span>
                    <span className="mono">{user.roomId}</span>
                    <span className={`badge ${user.presence.status === "live" ? "inverse" : ""}`}>{statusLabel(user.presence.status)}</span>
                    <span>{user.presence.viewers}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="card admin-card outage-card">
              <div className="section-title horizontal">
                <h2><AlertTriangle size={17} />断流日志</h2>
                <span className="mono">{selectedRoom || "选择用户查看"}</span>
              </div>
              <div className="outage-events">
                <div className="outage-head">
                  <span>时间</span>
                  <span>端</span>
                  <span>事件</span>
                  <span>关键数据</span>
                </div>
                {outageEvents.length === 0 && <p className="muted empty-state">暂无断流记录。</p>}
                {outageEvents.map((event) => (
                  <div className="outage-row" key={event.id}>
                    <span className="muted">{formatEventTime(event.createdAt)}</span>
                    <span className={`badge ${event.role === "broadcaster" ? "inverse" : ""}`}>{roleLabel(event.role)}</span>
                    <span className="outage-detail">
                      <strong>{outageLabel(event.type)}</strong>
                      <small>{outageSummary(event)}</small>
                    </span>
                    <span className="muted">{formatOutageMetrics(event)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card admin-card diagnostics-card">
              <div className="section-title horizontal">
                <h2><Activity size={17} />诊断事件</h2>
                <span className="mono">{selectedRoom || "选择用户查看"}</span>
              </div>
              <div className="events">
                {events.length === 0 && <p className="muted empty-state">暂无诊断事件。</p>}
                {events.map((event) => (
                  <div className="event" key={event.id}>
                    <span className="badge">{event.type}</span>
                    <span className="event-role">{event.role}</span>
                    <span>{event.detail || "-"}</span>
                    <span className="muted">{new Date(event.createdAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </main>
        </section>
      </section>
    </Shell>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="app-shell">
      <nav>
        <div><strong>{title}</strong><span>{subtitle}</span></div>
        <button className="ghost" onClick={() => { localStorage.clear(); window.location.href = "/"; }}><LogOut size={14} />退出</button>
      </nav>
      {children}
    </main>
  );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-title">
        <span className="badge inverse">WebTRC 2.0</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </main>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  return <label>{label}<input readOnly value={value} onFocus={(event) => event.currentTarget.select()} /></label>;
}

function statusLabel(status: string) {
  if (status === "live") return "直播中";
  if (status === "recovering") return "恢复中";
  return "离线";
}

function buildStatsDetail(status: ClientStatus) {
  return `${status.path ?? "DIRECT"} ${status.protocol ?? ""} ${status.resolution ?? ""}`.trim();
}

function buildStatsPayload(status: ClientStatus) {
  return {
    connection: status.connection,
    bitrateBps: status.bitrateBps ?? 0,
    fps: status.fps ?? null,
    path: status.path ?? null,
    protocol: status.protocol ?? null,
    resolution: status.resolution ?? null,
    rttMs: status.rttMs ?? null,
    packetsLost: status.packetsLost ?? null,
    jitterMs: status.jitterMs ?? null,
    availableOutgoingKbps: status.availableOutgoingKbps ?? null
  };
}

function postRecoveryEvent(input: {
  roomId: string;
  token?: string;
  role: "broadcaster" | "viewer";
  event: RecoveryEvent;
}) {
  return postRoomEvent({
    roomId: input.roomId,
    token: input.token,
    type: input.event.type,
    role: input.role,
    detail: input.event.detail,
    stats: input.event.stats
  }).catch(() => {});
}

const outageEventTypes = new Set([
  "stream_interrupted",
  "viewer_reconnect_requested",
  "viewer_media_lost",
  "viewer_media_recovered"
]);

function isOutageEvent(event: DiagnosticEvent) {
  return outageEventTypes.has(event.type);
}

function outageLabel(type: string) {
  if (type === "stream_interrupted") return "推流连接异常";
  if (type === "viewer_reconnect_requested") return "接收端重连";
  if (type === "viewer_media_lost") return "接收端无画面";
  if (type === "viewer_media_recovered") return "接收端恢复";
  return type;
}

function outageSummary(event: DiagnosticEvent) {
  if (event.detail && !event.detail.includes("???")) return event.detail;
  const stats = asStats(event.stats);
  if (typeof stats.reason === "string") return reasonLabel(stats.reason);
  return outageLabel(event.type);
}

function roleLabel(role: string) {
  if (role === "broadcaster") return "推流";
  if (role === "viewer") return "接收";
  return role;
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatOutageMetrics(event: DiagnosticEvent) {
  const stats = asStats(event.stats);
  const parts: string[] = [];
  const resolution = typeof stats.resolution === "string" ? stats.resolution : videoResolutionFromStats(stats);
  if (resolution) parts.push(resolution);
  if (typeof stats.fps === "number") parts.push(`${Math.round(stats.fps)}fps`);
  if (typeof stats.bitrateBps === "number" && stats.bitrateBps > 0) parts.push(formatBitrate(stats.bitrateBps));
  if (typeof stats.rttMs === "number") parts.push(`RTT ${Math.round(stats.rttMs)}ms`);
  if (typeof stats.jitterMs === "number") parts.push(`抖动 ${Math.round(stats.jitterMs)}ms`);
  if (typeof stats.connection === "string") parts.push(stats.connection);
  if (typeof stats.reason === "string") parts.push(reasonLabel(stats.reason));
  if (typeof stats.recoveredAfterMs === "number") parts.push(`${(stats.recoveredAfterMs / 1000).toFixed(1)}s恢复`);
  return parts.join(" · ") || event.detail || "-";
}

function asStats(stats: unknown) {
  return stats && typeof stats === "object" ? stats as Record<string, unknown> : {};
}

function videoResolutionFromStats(stats: Record<string, unknown>) {
  if (typeof stats.videoWidth === "number" && typeof stats.videoHeight === "number" && stats.videoWidth > 0 && stats.videoHeight > 0) {
    return `${stats.videoWidth}x${stats.videoHeight}`;
  }
  return "";
}

function reasonLabel(reason: string) {
  if (reason === "media-watchdog") return "画面检测";
  if (reason === "peer-unhealthy") return "连接异常";
  if (reason === "rebuild-timeout") return "重建超时";
  return reason;
}

function startAudioMeter(stream: MediaStream, onLevel: (level: number) => void) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return () => {};
  const AudioContextCtor = window.AudioContext;
  const context = new AudioContextCtor();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let frameId = 0;
  let active = true;

  function tick() {
    if (!active) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    onLevel(audioLevelToMeterPercent(Math.sqrt(sum / data.length)));
    frameId = requestAnimationFrame(tick);
  }
  tick();

  return () => {
    active = false;
    cancelAnimationFrame(frameId);
    void context.close().catch(() => {});
    onLevel(0);
  };
}

createRoot(document.getElementById("root")!).render(<App />);
