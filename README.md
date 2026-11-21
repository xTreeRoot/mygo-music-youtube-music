# YouTube · MB 跨平台插件

Fork 自 [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)。版本 **0.2.3**，需要宿主合同 0.1.28。插件 ID 保持 `youtube-music`，更新保留已有账号和设置。

默认首页及搜索来自普通 YouTube；YouTube Music 保留为“音乐专区”，旧音乐视频、Charts、New Releases 路由继续兼容。公开网页请求不发送原生 OAuth Bearer，避免网页客户端拒绝原生令牌导致 400。网页配置读取当前真实客户端配置，不拼接日期猜版本。

- 已登录首页与 Shorts 携带当前 OAuth 会话，使用实测接受原生令牌的 TVHTML5 推荐客户端；保留真实分组、顺序、独立栏目和整页续页。空推荐显示空态，不以热门榜或关键词搜索替代。公开搜索仍使用网页客户端，不把原生令牌发送给不兼容的 WEB / ANDROID 推荐接口。
- 首页分类来自账号 guide 返回的真实分类，通过可选目录 Tab 合同单行横滚、原地换内容；旧宿主可忽略 Tab 字段。
- Shorts 优先使用账号推荐中的 Shorts 栏目，读取服务端真实续页；游客缺少该栏目时读取官方 Shorts 序列，支持字符串 continuation、分批读取元信息、跨页去重和广告过滤。保留竖封面、作者及原链接。
- 订阅频道近期投稿、自己的频道/投稿和点赞的视频使用官方 YouTube Data API。移除平台播放列表导航、管理导出和本机观看记录入口，不再记录新的本机历史；已有资料库中播放列表详情引用仍可读取，不删除旧数据。
- 评论使用官方 Data API，游客使用公开视频的顶层评论；关闭评论返回空列表。官方配额耗尽时只读评论可回退网页。支持发表评论；旧授权缺少评论权限时，读取回退公开接口，发表需重新登录并同意 `youtube.force-ssl`。不宣称支持评论点赞或楼中楼。
- 公共字幕复用原生媒体客户端返回的 timedtext 地址，解析真实逐行时间；没有字幕时保留音乐歌词回退。空响应和网络错误明确报告，不伪造字幕。
- 视频默认选择最高可用 H.264 清晰度，移除旧版 720p 上限；返回真实可选画质，支持宿主通过 `video({id, quality: "1080p"})` 切换。只列出服务器实际提供的清晰度，竖屏按短边标注，缺少请求画质时向下回退并返回实际画质。
- 音视频使用 VISIONOS AAC/H.264 直链，保留签名及服务端播放限制，不依赖 ffmpeg、yt-dlp 或移动端外部进程。受限、未提供可用编码的资源明确报错；目前不提供 YouTube 上传、Premium 离线下载或直播转码。

## 安装与账号

从 GitHub 导入 `xTreeRoot/mygo-music-youtube-music`，或使用 [Releases](https://github.com/xTreeRoot/mygo-music-youtube-music/releases) 的 ZIP。

移动端通过宿主 `host.oauthSignIn` 打开系统浏览器，使用 PKCE/state 与各端注册的公开客户端完成授权，不读取浏览器 Cookie，也不依赖 Google Play 服务。Android 包名、原签名和回调协议保持不变。桌面保留原有网页授权入口。账号令牌仅保存在插件私有目录，退出只停用；取消、刷新失败及迟到响应不会替换有效会话。公开包没有用户令牌或客户端密钥。

Google 项目当前为外部测试模式，只允许已配置测试用户；测试模式刷新令牌通常七天失效，需重新授权。Data API 有服务端配额，错误会显示真实原因。推荐确实来自当前授权账号；TV、手机与网页终端受地区、时间、实验分组影响，推荐顺序不保证与手机官方 App 逐条一致。iOS Build 33 起宿主直接跳转外部默认浏览器并通过已注册回调返回；旧 iOS 宿主仍使用系统授权窗口。

## 验证

```sh
npm run check
npm test
```

0.2.3 的 38 项回归通过，覆盖 AAC/H.264 选流、公开请求授权隔离、TV/现代网页卡片、真实分类路由、账号首页、分类故障隔离、Shorts 顺序与续页去重、分页重载、空态、账号切换迟到响应、字幕、评论和 OAuth 会话保护。

2026-11-22 通过系统代理和现有账号实测首页 3 组 / 12 条、Shorts 两页 20 / 19 条、分类两页 13 / 6 条、首页纵向两页 15 / 15 条；这是当次响应，数量会变化。TV 推荐响应确认 `logged_in=1`。0.2.2 的真实选流验证仍适用，返回 1080p 到 144p，默认 CDN 分段请求 HTTP 206。

发布 ZIP 须包含 `plugin.json`、`index.js`、`music.js`、`oauth.js`、`youtube-web.js`、`youtube-api.js`、`youtube-feed.js` 和 `locales/`。不附带私有数据。

播放器互动总数：提供 `interactionSummary({trackId})` 返回平台公开的点赞和评论总数，隐藏计数保持未知。YouTube 使用已登录的官方 Data API；哔哩哔哩使用公开视频详情统计。
