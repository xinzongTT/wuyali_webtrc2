# WebTRC 2.0 VDO 对照优化记录

## 目标

WebTRC 2.0 保持现有上线站点不动，在新项目里按 VDO.Ninja 的低延迟 WebRTC 思路重做“手机摄像头到 OBS Browser Source”链路。

核心原则：

- 后端只做账号、后台、诊断、信令和 ICE 配置。
- 视频和音频媒体面走浏览器 WebRTC 直连，必要时走 TURN relay。
- 接收页可提前打开，推流端开播后自动协商并出画面。
- 默认竖屏 1080x1920、30fps，页面不裁切成方形。

## 已对照 VDO 落地的点

1. 音频默认 AUTO

   VDO 在默认摄像头/麦克风预览路径里优先使用 `audio: true`，让浏览器自己选择平台原生的回声消除、增益和降噪策略。WebTRC 2.0 已同步这个思路：未手动选择麦克风且非低延迟专业模式时，默认使用浏览器原生 AUTO，不再强制写入 `sampleRate` 和 `channelCount`。

2. 专业/低延迟音频可选

   当用户开启低延迟模式时，WebTRC 2.0 会关闭 `echoCancellation`、`autoGainControl` 和 `noiseSuppression`，对应 VDO 的 pro-audio 思路。这个模式会保留更原始的声音，但可能暴露手机底噪，适合用户自主选择。

3. 信令心跳

   VDO 的长期连接逻辑会持续维护连接状态。WebTRC 2.0 已增加 WebSocket heartbeat：客户端每 10 秒发送一次保活包，服务端静默消费，不广播给房间内其他 peer，降低代理/Nginx/移动网络空闲断开后黑屏的概率。

4. viewer 自动接收

   viewer 先进入房间时会注册等待；broadcaster 加入后，服务端把已有 viewer 发送给 broadcaster，broadcaster 立即发 offer。这个行为已经有自动化测试覆盖。

5. 诊断可观测

   推流端和接收端每 10 秒上报 WebRTC stats，后台可看到路径、协议、分辨率、fps、RTT、丢包、jitter、可用上行和实时码率。

## 与 VDO 仍不同的点

- WebTRC 2.0 当前是单房间账号体系，功能面远少于 VDO，目标是 OBS 摄入稳定，不是完整会议系统。
- VDO 有更复杂的多参数 URL 控制、编解码选择、chunked/meshcast/SFU/WHIP 等高级链路；WebTRC 2.0 当前保留直连/TURN WebRTC 主链路。
- WebTRC 2.0 的 TURN 由后台配置，暂未内置动态 TURN 调度和多区域探测。

## 下一步建议

- 增加后台“连接质量历史”视图，把一小时内的 bitrate/fps/RTT/loss 折线化。
- 增加 OBS 专用接收页参数，例如 `?controls=0&fit=contain&muted=0`，便于不同 OBS 场景固定行为。
- 增加 TURN 多节点健康检查和优选排序，优先选择 RTT 更低的 relay。
- 增加真实移动端长测脚本说明，把手机端测试结果和浏览器 fake media e2e 区分记录。
