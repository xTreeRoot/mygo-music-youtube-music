# YouTube Music · MB 跨平台插件

Fork 自 [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)，保留上游页面、搜索、歌单、账号与歌词实现。版本 **0.1.5**，宿主插件兼容版本至少 0.1.26。桌面、iOS 与 Android 使用同一份包，无需桌面进程。

## 音乐与视频

原版通过 `host.spawn` 启动 ffmpeg 转 MP3，失败后使用 yt-dlp，并依赖 PATH/Homebrew 和 JavaScript runtime。这些桌面进程不能在 MB iOS 中启动。

音频沿用上游 VISIONOS player 请求，选择服务端提供的 AAC/MP4 音频直链。请求无损时返回实际可用的有损音质，不启动外部程序。

只有进行中的音视频解析共享请求；宿主在地址失效后可以重新解析同一档位，不复用已完成的直链。

- `browse({page:"videos"})` 首页分成新发 MV 和地区视频榜。新发行预览的「查看更多」打开完整视频库；地区榜打开以平台排序的横版视频卡，不混入纯音轨或播客。使用平台原始横封面，并保留作者与时长。
- `searchVideos({query,offset})` 使用 YouTube Music 的视频筛选和独立续页，返回 `{tracks,more}`；宿主按可选导出决定是否显示视频搜索。同一筛选也可用 `search({kind:"videos",query,offset})` 调用。普通歌曲或视频搜索框也接受 `youtube.com/watch`、`music.youtube.com/watch` 和 `youtu.be` 的公开链接，所选视频必须有宿主可播的 H.264 和 AAC。
- `video({id,quality})` 只返回可供原生播放器使用的直出 H.264 MP4，拒绝只有音轨、签名密文或不被支持的编解码格式的响应。浏览不会触发播放，也不改变当前播放项。
- `comments({trackId,offset})` 适用于已接入插件评论的宿主，按平台返回顺序读取公开顶层评论并续页。不发评论、不点赞、不读取楼中楼，也不把近似值当成精确的日期或赞数。
- 登录后继续使用已有的喜欢、歌单浏览和播放历史。首页和关键词搜索仍来自 YouTube Music，不是普通 YouTube App 的全站推荐；不声明订阅、上传、直播或 Shorts 信息流。

## 安装

在 MB 插件页从 GitHub 安装 `xTreeRoot/mygo-music-youtube-music`，或导入 [Releases](https://github.com/xTreeRoot/mygo-music-youtube-music/releases) 中的 ZIP。插件 ID 仍为 `youtube-music`。

需要当前设备网络能够访问 YouTube。iOS 登录改用 `host.oauthSignIn`：系统 ASWebAuthenticationSession 打开 Google 授权，宿主生成 PKCE/state 并交换授权码，不再通过内嵌 WKWebView 提取 Cookie。使用 MB 自己的公开 iOS 客户端 ID，回调 scheme 必须在 App 中注册。请求 `https://www.googleapis.com/auth/youtube` 以兼容原有喜欢、歌单和播放历史；每次账号访问仍由用户在 Google 页面授权。

当前 OAuth 应用处于外部测试模式，只允许配置的测试用户；Google 测试模式下刷新令牌通常 7 天失效，届时需重新授权。桌面保留既有网页桥，Android 缺少登录桥时仍可使用游客功能。系统浏览器使用系统网络，不受 MB 的 URLSession 域名代理开关控制。

令牌保存在宿主提供的插件私有数据目录，退出仅停用，重新登录先验证本地保留的会话。候选会话验证成功才替换旧值；取消、刷新网络失败和迟到响应不会覆盖旧登录。源码与安装包只包含公开客户端配置，没有用户令牌或客户端密钥。

## 验证范围

AAC/H.264 选流、原始封面、完整新发行库、地区视频榜、链接搜索、评论续页及 OAuth 会话验证/刷新/取消有自动回归。Google 登录和各端完整播放及 UI 仍需真机验收。

```sh
npm run check
npm test
```

此插件不隶属于 YouTube 或 Google，依赖上游私有 API，可能随服务变动失效。歌词来源保留 [Better Lyrics](https://github.com/better-lyrics/better-lyrics)。账号会话由宿主插件私有存储保存，不包含在源码或安装包中。

公开插件包必须同时包含 `plugin.json`、`index.js`、`oauth.js` 和 `locales/`，不能只复制入口文件。
