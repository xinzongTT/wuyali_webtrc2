# WebTRC 2.0

WebTRC 2.0 是一个独立新项目，用 VDO.Ninja 的 WebRTC 思路重做低延迟“手机直播到 OBS Browser Source”链路。

当前版本目标：

- 用户用直播间 ID 和密码登录，一键开启直播。
- 接收端页面可以先打开，开播后自动收到视频。
- Node 后端只负责账号、后台、诊断和 WebSocket 信令，媒体走 WebRTC 直连或 TURN relay。
- 后台支持创建用户、查看直播状态、查看诊断事件、配置 STUN/TURN 和默认低延迟模式。
- 开播端和接收端每 10 秒节流上报 WebRTC stats，后台诊断可看到路径、协议、分辨率、fps、RTT、丢包、jitter 和可用上行。
- 手机默认请求竖屏 `1080x1920 / 30fps`，预览和接收页默认 `contain`，不裁成方形。

## 本地运行

```powershell
npm install
npm run dev
```

默认地址：

- Web: `http://localhost:5175`
- API: `http://localhost:4200`
- 管理后台: `http://localhost:5175/admin/login`

默认管理员：

- 用户名：`admin`
- 密码：`admin123456`

## 验证

```powershell
npm run test
npm run typecheck
npm run build
npm run e2e:webrtc
npm audit
```

`npm run e2e:webrtc` 会自动创建一个临时直播间，用 Chromium fake camera/mic 验证：接收页先打开，开播后自动收到视频并显示分辨率。
