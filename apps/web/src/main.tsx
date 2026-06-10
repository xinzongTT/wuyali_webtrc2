import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Camera, LogOut, Mic, Monitor, Play, Plus, Radio, Settings, Shield, Square, Users } from "lucide-react";
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
import { LiveClient, type ClientStatus } from "./webrtc-client";
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
      }
    });
    current.start();
    return () => current.stop();
  }, [roomId]);

  return (
    <main className="viewer-page">
      <video ref={videoRef} className={fit} playsInline autoPlay controls />
      <div className="viewer-status">
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

  return (
    <Shell title="管理员后台" subtitle="账号、直播状态、TURN 和诊断">
      <section className="admin-grid">
        <form className="card" onSubmit={createUser}>
          <h2><Plus size={18} />创建用户</h2>
          <label>直播间 ID<input value={roomId} onChange={(e) => setRoomId(e.target.value.toLowerCase())} /></label>
          <label>显示名称<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
          <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit"><Plus size={16} />创建</button>
        </form>

        <div className="card span-2">
          <h2><Users size={18} />用户列表</h2>
          <div className="table">
            {users.map((user) => (
              <button key={user.id} className="table-row" onClick={() => openDiagnostics(user.roomId)}>
                <span>{user.displayName}</span>
                <span className="mono">{user.roomId}</span>
                <span className={`badge ${user.presence.status === "live" ? "inverse" : ""}`}>{statusLabel(user.presence.status)}</span>
                <span>{user.presence.viewers} 接收端</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card span-2">
          <h2><Settings size={18} />WebRTC 设置</h2>
          {settings && (
            <div className="settings-grid">
              <label>STUN<input value={settings.stunUrls} onChange={(e) => setSettings({ ...settings, stunUrls: e.target.value })} /></label>
              <label>TURN URLs<input value={settings.turnUrls} onChange={(e) => setSettings({ ...settings, turnUrls: e.target.value })} /></label>
              <label>TURN 用户名<input value={settings.turnUsername} onChange={(e) => setSettings({ ...settings, turnUsername: e.target.value })} /></label>
              <label>TURN 密码<input value={settings.turnCredential} onChange={(e) => setSettings({ ...settings, turnCredential: e.target.value })} /></label>
              <label className="check"><input type="checkbox" checked={settings.forceRelay} onChange={(e) => setSettings({ ...settings, forceRelay: e.target.checked })} />强制 TURN 诊断</label>
              <label className="check"><input type="checkbox" checked={settings.lowLatencyDefault} onChange={(e) => setSettings({ ...settings, lowLatencyDefault: e.target.checked })} />默认低延迟模式</label>
              <button className="primary" onClick={saveSettings}><Settings size={16} />保存设置</button>
            </div>
          )}
        </div>

        <div className="card span-3">
          <h2><Activity size={18} />诊断事件 {selectedRoom && <span className="mono">{selectedRoom}</span>}</h2>
          <div className="events">
            {events.length === 0 && <p className="muted">选择一个用户查看诊断事件。</p>}
            {events.map((event) => (
              <div className="event" key={event.id}>
                <span className="badge">{event.type}</span>
                <span>{event.role}</span>
                <span>{event.detail}</span>
                <span className="muted">{new Date(event.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
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
