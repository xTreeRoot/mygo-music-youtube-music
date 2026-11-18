# YouTube Music · MB iOS 兼容版

Fork 自 [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)，保留上游页面、搜索、歌单、账号与歌词实现。版本 **0.1.2**，宿主插件兼容版本至少 0.1.21。

## iOS 适配

原版通过 `host.spawn` 启动 ffmpeg 转 MP3，失败后使用 yt-dlp，并依赖 PATH/Homebrew 和 JavaScript runtime。这些桌面进程不能在 MB iOS 中启动。

本版沿用上游 VISIONOS player 请求，只选择服务端提供的 AAC/MP4 音频直链，交给 AVFoundation 原生播放。移除外部进程权限与本地 HTTP 转码服务；请求无损时返回实际可用的有损音质。没有可用 AAC 或服务要求额外验证时正常报错，不启动外部程序。

## 安装

在 MB 插件页从 GitHub 安装 `xTreeRoot/mygo-music-youtube-music`，或导入 [Releases](https://github.com/xTreeRoot/mygo-music-youtube-music/releases) 中的 ZIP。插件 ID 仍为 `youtube-music`。

需要当前设备网络能够访问 YouTube。账号登录仍使用宿主的网页登录能力；Google 是否接受内嵌网页登录由服务端决定，iOS 登录尚未验收。

## 验证范围

原生 AAC 选择、音质降级、并发请求共享、缓存及不可播放响应已有自动回归。MB 真实 QuickJS 宿主已在可访问 YouTube 的网络下完成取流、完整音频下载与 AVFoundation 可播放性检查；iOS 设备上的实际播放与 Google 登录仍需使用验收。

```sh
npm run check
npm test
```

此插件不隶属于 YouTube 或 Google，依赖上游私有 API，可能随服务变动失效。歌词来源保留 [Better Lyrics](https://github.com/better-lyrics/better-lyrics)。账号会话由宿主插件私有存储保存，不包含在源码或安装包中。
