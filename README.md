# YouTube Music · MB 跨平台插件

Fork 自 [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)，保留上游页面、搜索、歌单、账号与歌词实现。版本 **0.1.3**，宿主插件兼容版本至少 0.1.21。桌面、iOS 与 Android 使用同一份包，无需桌面进程。

## 音乐与视频

原版通过 `host.spawn` 启动 ffmpeg 转 MP3，失败后使用 yt-dlp，并依赖 PATH/Homebrew 和 JavaScript runtime。这些桌面进程不能在 MB iOS 中启动。

音频沿用上游 VISIONOS player 请求，选择服务端提供的 AAC/MP4 音频直链。请求无损时返回实际可用的有损音质，不启动外部程序。

- `browse({page:"videos"})` 优先展示 YouTube Music「新发行」中的视频分区，必要时回退首页视频推荐，并提供排行榜入口。保留真实视频的顺序、标题、作者、封面和时长，不拿纯音轨凑数。
- `searchVideos({query,offset})` 使用 YouTube Music 的视频筛选和独立续页，返回 `{tracks,more}`；宿主按这项可选导出判断是否显示视频搜索。同一筛选也可用 `search({kind:"videos",query,offset})` 调用，普通搜索保持原样。
- `video({id,quality})` 只返回可供原生播放器使用的直出 H.264 MP4，拒绝只有音轨、签名密文或不被支持的编解码格式的响应。浏览不会触发播放，也不改变当前播放项。
- 登录后继续使用已有的喜欢、歌单浏览和播放历史。首页和搜索来自 YouTube Music，不是普通 YouTube App 的全站推荐；不声明评论、订阅、上传或 Shorts。

## 安装

在 MB 插件页从 GitHub 安装 `xTreeRoot/mygo-music-youtube-music`，或导入 [Releases](https://github.com/xTreeRoot/mygo-music-youtube-music/releases) 中的 ZIP。插件 ID 仍为 `youtube-music`。

需要当前设备网络能够访问 YouTube。登录需要宿主提供网页窗口，当前 Android 宿主缺少这条桥接，仍可以用游客功能。Google 是否接受内嵌网页登录由服务端决定，不同步 Google Cookie。

## 验证范围

AAC 选择、真实内容卡片映射、视频分页、并发取流、H.264 选流及不可播放响应有自动回归。上一版曾在可访问 YouTube 的网络下通过音频下载与 AVFoundation 解码；0.1.3 的 YouTube 实际视频、Google 登录和全端 UI 仍待验收。

```sh
npm run check
npm test
```

此插件不隶属于 YouTube 或 Google，依赖上游私有 API，可能随服务变动失效。歌词来源保留 [Better Lyrics](https://github.com/better-lyrics/better-lyrics)。账号会话由宿主插件私有存储保存，不包含在源码或安装包中。
