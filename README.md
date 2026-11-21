# YouTube · MB 跨平台插件

Fork 自 [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)。版本 **0.2.1**，需要宿主合同 0.1.28。插件 ID 保持 `youtube-music`，更新保留已有账号和设置。

默认首页及搜索来自普通 YouTube；YouTube Music 保留为“音乐专区”，旧音乐视频、Charts、New Releases 路由继续兼容。公开网页请求不发送原生 OAuth Bearer，避免网页客户端拒绝原生令牌导致 400。网页配置读取当前真实客户端配置，不拼接日期猜版本。

- 普通视频首页、搜索、频道与播放列表搜索；没有网页观看历史的访客首页明确展示热门视频。
- Shorts 使用网页返回的序列和续页令牌，保留短视频标记、封面尺寸、作者及原链接；宿主根据实际解码尺寸适配竖屏。
- 订阅频道近期投稿、自己的频道/投稿、点赞的视频和播放列表使用官方 YouTube Data API；支持创建、重命名、删除列表、增删列表内容及关注频道。
- 观看记录是本机播放记录。官方 Data API 不开放账号历史和系统 Watch Later；“稍后观看 · MB”使用可同步的普通私有播放列表 `MB 稍后观看`，与 YouTube 系统列表区别显示。可在播放列表操作中加入内容。
- 评论使用官方 Data API，游客使用公开视频的顶层评论；关闭评论返回空列表。官方配额耗尽时只读评论可回退网页。支持发表评论；旧授权缺少评论权限时，读取回退公开接口，发表需重新登录并同意 `youtube.force-ssl`。不宣称支持评论点赞或楼中楼。
- 公共字幕复用原生媒体客户端返回的 timedtext 地址，解析真实逐行时间；没有字幕时保留音乐歌词回退。空响应和网络错误明确报告，不伪造字幕。
- 音视频使用 VISIONOS AAC/H.264 直链，保留签名及服务端播放限制，不依赖 ffmpeg、yt-dlp 或移动端外部进程。受限、未提供可用编码的资源明确报错；目前不提供 YouTube 上传、Premium 离线下载或直播转码。

## 安装与账号

从 GitHub 导入 `xTreeRoot/mygo-music-youtube-music`，或使用 [Releases](https://github.com/xTreeRoot/mygo-music-youtube-music/releases) 的 ZIP。

移动端通过宿主 `host.oauthSignIn` 打开系统浏览器，使用 PKCE/state 与各端注册的公开客户端完成授权，不读取浏览器 Cookie，也不依赖 Google Play 服务。Android 包名、原签名和回调协议保持不变。桌面保留原有网页授权入口。账号令牌仅保存在插件私有目录，退出只停用；取消、刷新失败及迟到响应不会替换有效会话。公开包没有用户令牌或客户端密钥。

Google 项目当前为外部测试模式，只允许已配置测试用户；测试模式刷新令牌通常七天失效，需重新授权。Data API 有服务端配额，错误会显示真实原因。普通首页和推荐不会冒充官方账号的个性化主页；主题入口在没有对应官方分类流时使用同名公开搜索。

## 验证

```sh
npm run check
npm test
```

回归覆盖 AAC/H.264 选流、400 公开请求隔离、网页登录配置、普通搜索续页、Shorts 序列、字幕时间、顶层评论续页、播放列表删除条目 ID、OAuth 刷新/取消与账号保护。真实网络验证覆盖普通首页、搜索、Shorts 两页、评论、字幕、音乐专区、Charts、新发行和音乐视频。

发布 ZIP 须包含 `plugin.json`、`index.js`、`music.js`、`oauth.js`、`youtube-web.js`、`youtube-api.js` 和 `locales/`。不附带私有数据。

播放器互动总数：提供 `interactionSummary({trackId})` 返回平台公开的点赞和评论总数，隐藏计数保持未知。YouTube 使用已登录的官方 Data API；哔哩哔哩使用公开视频详情统计。
