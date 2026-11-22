// YouTube Music for MB, based on egoist/mygo-music-youtube-music.
import { automaticVideo, playerCache } from "./media-policy.js";
import { hasOAuth, oauthHeaders, signInOAuth, endOAuth, isOAuthSignInPending } from "./oauth.js";

const site = "https://music.youtube.com";
const validVideoID = id => typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
const webUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// What the plugin says is in the listener's language, from locales/zh-CN.json.
const t = host.t;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The session's cookies, as a Cookie header, kept in the plugin's storage.
const cookie = () => host.storage.get("cookieActive") === false ? "" : host.storage.get("cookie") || "";
let accountRevision = 0;
const hasSession = () => hasOAuth() || Boolean(cookie());

function cookieValue(name) {
  for (const part of cookie().split(";")) {
    const at = part.indexOf("=");
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

function needAccount() {
  if (!hasSession()) throw fail("signIn");
}

function sha1(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let at = 0; at < bytes.length; at += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[at + i * 4] << 24) | (bytes[at + i * 4 + 1] << 16) | (bytes[at + i * 4 + 2] << 8) | bytes[at + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
    }
    [a, b, c, d, e].forEach((v, i) => (h[i] = (h[i] + v) | 0));
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

// What the website sends to say whose session this is, to the site at origin.
export async function authHeaders(origin = site) {
  const destination = new URL(origin);
  if (destination.protocol !== "https:" || destination.username || destination.password ||
      !["music.youtube.com", "www.youtube.com", "youtube.com", "s.youtube.com"].includes(destination.hostname) ||
      (destination.port && destination.port !== "443")) throw new Error("Invalid account request destination");
  if (hasOAuth()) return oauthHeaders();
  const sapisid = cookieValue("__Secure-3PAPISID") || cookieValue("SAPISID");
  if (!sapisid) return {};
  const now = Math.floor(Date.now() / 1000);
  return {
    cookie: cookie(),
    authorization: `SAPISIDHASH ${now}_${sha1(`${now} ${sapisid} ${origin}`)}`,
    "x-goog-authuser": "0",
  };
}

// 与 2026-11-21 音乐网页实际返回配置一致；拒绝时从网页刷新，绝不按日期拼造版本。
let musicClientVersion = '1.20261117.06.00';
function clientVersion() { return musicClientVersion; }
async function refreshMusicClient() {
  const response = await fetch(site + '/', { headers: { 'user-agent': webUA } });
  if (!response.ok) throw new Error(`YouTube Music 配置 HTTP ${response.status}`);
  const html = await response.text();
  const version = /"INNERTUBE_CLIENT_VERSION":"([0-9.]+)"/.exec(html)?.[1];
  if (!version) throw new Error('YouTube Music 网页配置不可用');
  musicClientVersion = version;
}

// The apps the service tells apart, as a request says it's from one of them.
const remix = {
  get client() {
    // YouTube's own titles, such as its shelves', come in the listener's language.
    return { clientName: "WEB_REMIX", clientVersion: clientVersion(), hl: host.language() === "zh-CN" ? "zh-CN" : "en" };
  },
};

// Its Android app, which is told when each line of the lyrics is sung, where
// the website only gets the words.
const android = {
  client: { clientName: "ANDROID_MUSIC", clientVersion: "7.21.50", androidSdkVersion: 34 },
  headers: { "user-agent": "com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 14) gzip" },
};

// YouTube's app for the Vision Pro, which is given audio at addresses that need
// no signature worked out, nor YouTube's JavaScript run. It asks as a visitor:
// a session is turned down.
const visionUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const visionOS = (visitor) => ({
  client: {
    clientName: "VISIONOS",
    clientVersion: "1.02",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    userAgent: visionUA,
    osName: "visionOS",
    osVersion: "26.5.23O471",
    visitorData: visitor,
  },
  headers: {
    "user-agent": visionUA,
    "x-goog-visitor-id": visitor,
    "x-youtube-client-name": "101",
    "x-youtube-client-version": "1.02",
  },
  anonymous: true,
});

// call asks the service as the website, or as another of its apps. An
// anonymous call leaves the session out.
async function call(endpoint, body, as = remix) {
  const generation = accountRevision;
  const res = await fetch(`${site}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": webUA,
      origin: site,
      "x-origin": site,
      ...(as.anonymous ? {} : await authHeaders()),
      ...as.headers,
    },
    body: JSON.stringify({ context: { client: as.client, user: {} }, ...body }),
  });
  if (res.status === 401 && !as.anonymous) {
    if (generation === accountRevision && !isOAuthSignInPending()) endSession();
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  }
  if (!res.ok) {
    const error = new Error(`${endpoint}: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Public YouTube Music pages may reject a native OAuth bearer token with a
// generic 400 even though the same page is available to a visitor. Retry only
// those public requests anonymously; account collections and mutations keep
// their authenticated error so a private failure is never mistaken for guest
// data.
async function publicCall(endpoint, body, as = remix) {
  if (hasOAuth()) {
    try { return await call(endpoint, body, { ...as, anonymous: true }); }
    catch (error) {
      if (error.status !== 400 || as.client.clientName !== 'WEB_REMIX') throw error;
      await refreshMusicClient();
      return call(endpoint, body, { ...as, client: { ...as.client, clientVersion: musicClientVersion }, anonymous: true });
    }
  }
  try {
    return await call(endpoint, body, as);
  } catch (error) {
    if (as.anonymous || error.status !== 400) throw error;
    return call(endpoint, body, { ...as, anonymous: true });
  }
}

const browseId = (id) => call("browse", { browseId: id });
const publicBrowseId = (id, as = remix) => publicCall("browse", { browseId: id }, as);

// Answers are deep and change shape, so what's in them is found by name.

function findAll(node, name, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, name, out);
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === name) out.push(node[key]);
      else findAll(node[key], name, out);
    }
  }
  return out;
}
const findOne = (node, name) => findAll(node, name)[0];

const textOf = (t) => (t ? t.simpleText || (t.runs || []).map((r) => r.text).join("") : "");

// Covers come in the size asked for in their address.
function imageOf(node, video = false) {
  const list = node && findOne(node, "thumbnails");
  const url = list && list.length ? list[list.length - 1].url : "";
  if (!url) return undefined;
  if (video) {
    const wide = list.filter(image => image.width / image.height >= 1.6);
    return wide.reduce((best, image) => image.width >= best.width ? image : best, wide[0] || { width: 0, url }).url;
  }
  return url.replace(/=w\d+-h\d+[^/]*$/, "=w544-h544-l90-rj");
}

function msOf(text) {
  if (!text || !/^\d+(:\d+)+$/.test(text)) return 0;
  return text.split(":").reduce((sum, n) => sum * 60 + Number(n), 0) * 1000;
}

const pageTypeOf = (nav) =>
  nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || "";

const plainPlaylistId = (id) => (id || "").replace(/^VL/, "");

// What a line of credits names: who, on which album, and for how long.
function creditsOf(runs) {
  const out = { artists: [], album: null, duration: 0, names: [] };
  for (const run of runs || []) {
    const text = run.text;
    if (!text || /^\s*[•·,&]\s*$/.test(text)) continue;
    const nav = run.navigationEndpoint;
    const type = pageTypeOf(nav);
    if (type === "MUSIC_PAGE_TYPE_ARTIST" || type === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
      out.artists.push({ id: nav.browseEndpoint.browseId, name: text });
    } else if (type === "MUSIC_PAGE_TYPE_ALBUM" || type === "MUSIC_PAGE_TYPE_AUDIOBOOK") {
      out.album = { id: nav.browseEndpoint.browseId, name: text };
    } else if (msOf(text)) {
      out.duration = msOf(text);
    } else {
      out.names.push(text);
    }
  }
  return out;
}

function trackFrom(id, name, credits, image, unavailable, video = false) {
  // A track whose artist has no page of their own only has them as words, the
  // first of which may be its kind in a list of everything.
  const artists = credits.artists.length
    ? credits.artists
    : credits.names.slice(0, 1).map((n) => ({ id: "", name: n }));
  return {
    id,
    name,
    artists,
    album: credits.album ? { ...credits.album, imageUrl: image } : { id: "", name: "", imageUrl: image },
    duration: credits.duration,
    url: `${video ? "https://www.youtube.com" : site}/watch?v=${id}`,
    unavailable: unavailable || undefined,
  };
}

function isMusicVideo(endpoint) {
  const type = endpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
  return type === "MUSIC_VIDEO_TYPE_OMV" || type === "MUSIC_VIDEO_TYPE_UGC" || type === "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC";
}

// A row of a list: a song, or what a search for other things finds.
function rowOf(r) {
  const columns = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
  const name = textOf(columns[0]);
  const nav = columns[0]?.runs?.[0]?.navigationEndpoint;
  const play = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint;
  const videoId = r.playlistItemData?.videoId || nav?.watchEndpoint?.videoId || play?.videoId;
  const runs = columns.slice(1).flatMap((c) => [...(c?.runs || []), { text: "•" }]);
  const fixed = (r.fixedColumns || []).map((c) => textOf(c.musicResponsiveListItemFixedColumnRenderer?.text));
  const credits = creditsOf(runs);
  credits.duration = credits.duration || msOf(fixed[0]);
  if (videoId) {
    const grey = r.musicItemRendererDisplayPolicy === "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";
    const video = isMusicVideo(nav?.watchEndpoint) || isMusicVideo(play);
    if (video && /^(video|音乐视频|视频)$/i.test(credits.names[0] || "")) credits.names.shift();
    return { kind: "track", video, value: trackFrom(videoId, name, credits, imageOf(r.thumbnail, video), grey, video) };
  }
  const target = r.navigationEndpoint;
  return collectionOf(target, name, runs, imageOf(r.thumbnail));
}

// A card: anything at all, by where it leads.
function cardOf(r) {
  const name = textOf(r.title);
  const runs = r.subtitle?.runs || [];
  const nav = r.navigationEndpoint;
  if (nav?.watchEndpoint?.videoId) {
    const credits = creditsOf(runs);
    const video = isMusicVideo(nav.watchEndpoint);
    if (!video || /^(video|音乐视频|视频)$/i.test(credits.names[0] || "")) credits.names.shift();
    if (video) credits.names = credits.names.filter(name => !/(?:\bviews?$|次观看$)/i.test(name));
    return { kind: "track", video, value: trackFrom(nav.watchEndpoint.videoId, name, credits, imageOf(r.thumbnailRenderer, video), false, video) };
  }
  return collectionOf(nav, name, runs, imageOf(r.thumbnailRenderer));
}

function collectionOf(nav, name, runs, image) {
  const id = nav?.browseEndpoint?.browseId;
  if (!id) return null;
  const credits = creditsOf(runs);
  switch (pageTypeOf(nav)) {
    case "MUSIC_PAGE_TYPE_ARTIST":
    case "MUSIC_PAGE_TYPE_USER_CHANNEL":
      return { kind: "artist", value: { id, name, imageUrl: image } };
    case "MUSIC_PAGE_TYPE_ALBUM":
    case "MUSIC_PAGE_TYPE_AUDIOBOOK":
      return { kind: "album", value: { id, name, imageUrl: image, artists: credits.artists, released: credits.names.find((n) => /^\d{4}$/.test(n)) } };
    case "MUSIC_PAGE_TYPE_PLAYLIST":
      return { kind: "playlist", value: { id: plainPlaylistId(id), name, imageUrl: image, owner: credits.artists[0]?.name || credits.names[1] || "" } };
  }
  return null;
}

function itemsOf(list) {
  const out = [];
  for (const item of list || []) {
    const row = item.musicResponsiveListItemRenderer;
    const card = item.musicTwoRowItemRenderer;
    const got = row ? rowOf(row) : card ? cardOf(card) : null;
    if (got) out.push(got);
  }
  return out;
}

const ofKind = (items, kind) => items.filter((i) => i.kind === kind).map((i) => i.value);

function videoItems(items, seen = new Set()) {
  return items.filter(({ video, value }) => {
    if (!video || value.unavailable || !validVideoID(value.id) || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

// Some lists leave out how long a song is, and the app needs that to seek and
// to know when it ends. The queue answers for many at once.
async function withDurations(tracks) {
  const missing = tracks.filter((t) => !t.duration).map((t) => t.id);
  if (!missing.length) return tracks;
  const known = {};
  try {
    const r = await publicCall("music/get_queue", { videoIds: [...new Set(missing)].slice(0, 100) });
    for (const v of findAll(r, "playlistPanelVideoRenderer")) known[v.videoId] = msOf(textOf(v.lengthText));
  } catch (e) {
    console.warn(`get_queue: ${e.message}`);
  }
  for (const t of tracks) t.duration = t.duration || known[t.id] || 0;
  return tracks;
}

function shelfTitle(shelf) {
  return textOf(shelf.title) || textOf(findOne(shelf.header, "title"));
}

// The sections of a page of shelves, in their order.
async function sectionsOf(answer, videosOnly = false, limit = Infinity) {
  const sections = [];
  const seen = new Set();
  for (const list of findAll(answer, "sectionListRenderer").concat(findAll(answer, "sectionListContinuation"))) {
    for (const entry of list.contents || []) {
      const shelf =
        entry.musicCarouselShelfRenderer || entry.musicShelfRenderer || entry.musicPlaylistShelfRenderer || entry.gridRenderer;
      if (!shelf) continue;
      const raw = itemsOf(shelf.contents || shelf.items);
      const items = videosOnly ? videoItems(raw, seen).slice(0, limit) : raw;
      if (!items.length) continue;
      sections.push({
        title: shelfTitle(shelf),
        tracks: await withDurations(ofKind(items, "track")),
        trackLayout: items.every(item => item.video) ? "videos" : undefined,
        albums: ofKind(items, "album"),
        artists: ofKind(items, "artist"),
        playlists: ofKind(items, "playlist"),
      });
    }
  }
  return sections;
}

// A next page's token, in either of the ways it's given.
function nextToken(node) {
  if (!node) return "";
  const old = findOne(node, "nextContinuationData");
  if (old?.continuation) return old.continuation;
  return findOne(node, "continuationCommand")?.token || "";
}

// The app asks for pages by how much it has, the service by a token: this is
// which token goes with how much.
const tokens = new Map();
function pageToken(key, offset) {
  return offset > 0 ? tokens.get(`${key}\0${offset}`) : null;
}
function keepToken(key, offset, token) {
  const entry = `${key}\0${offset}`;
  if (token) {
    if (tokens.size >= 256 && !tokens.has(entry)) tokens.delete(tokens.keys().next().value);
    tokens.set(entry, token);
  } else tokens.delete(entry);
  return Boolean(token);
}

// What a page's rows are, and its next token. Those of a next page aren't where
// the first page's are.
function rowsOf(answer) {
  const further = findOne(answer, "onResponseReceivedActions") || findOne(answer, "musicShelfContinuation") || findOne(answer, "musicPlaylistShelfContinuation");
  if (further) {
    const list = findAll(further, "continuationItems")[0] || further.contents || [];
    return { items: itemsOf(list), token: nextToken(further) };
  }
  const shelf = findOne(answer, "musicPlaylistShelfRenderer") || findOne(answer, "musicShelfRenderer");
  return { items: itemsOf(shelf?.contents), token: nextToken(shelf) };
}

// Account.

export async function account() {
  if (!hasSession()) return null;
  if (hasOAuth()) {
    // iOS OAuth uses the documented Data API; the website account menu can reject native client tokens.
    const res = await fetch("https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      method: "GET", headers: await oauthHeaders(),
    });
    if (!res.ok) throw new Error(`YouTube 账号读取失败（HTTP ${res.status}）`);
    const channel = (await res.json()).items?.[0];
    if (!channel?.id || !channel.snippet?.title) throw new Error("此 Google 账号没有可用的 YouTube 频道，请先在 YouTube 创建频道后重试");
    const images = channel.snippet.thumbnails || {};
    return { id: channel.id, name: channel.snippet.title, imageUrl: (images.high || images.medium || images.default)?.url };
  }
  const r = await call("account/account_menu", {});
  const header = findOne(r, "activeAccountHeaderRenderer");
  if (!header) return null;
  const name = textOf(header.accountName);
  return { id: textOf(header.channelHandle) || name, name, imageUrl: imageOf(header.accountPhoto) };
}

// Signing in is on Google's own page, as YouTube Music's website signs in, in a
// window the app shows. It's done once Google gives YouTube the session.
const signInPage =
  "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true" +
  "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F";

// Desktop hosts retain their existing web sign-in; mobile hosts use system OAuth below.
const browserUA =
  host.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

export async function signIn({ commentAccess = false } = {}) {
  accountRevision += 1;
  if (host.platform === "ios" || host.platform === "android") {
    likedSet = null;
    const me = await signInOAuth(account, commentAccess ? ["https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.force-ssl"] : undefined);
    host.storage.set("cookieActive", false);
    return me;
  }
  if (typeof host.webSignIn !== "function") throw fail("setup", t("This host cannot show the YouTube Music sign-in page"));
  const result = await host.webSignIn({ url: signInPage, cookiesOf: site, until: ["SAPISID", "__Secure-3PSID"], userAgent: browserUA });
  const { cookie: session } = result;
  host.storage.set("cookie", session);
  host.storage.set("cookieActive", true);
  likedSet = null;
  const me = await account();
  if (!me) {
    endSession();
    throw new Error(t("YouTube Music didn't take that sign-in: try again"));
  }
  return me;
}

export function signOut() {
  endSession();
}

// 退出仅停用插件私有目录中的会话，重新登录先验证后复用。
function endSession() {
  accountRevision += 1;
  endOAuth();
  host.storage.set("cookieActive", false);
  likedSet = null;
}

// Pages.

async function discovery(videosOnly = false) {
  let as = remix;
  let answer;
  try { answer = await call("browse", { browseId: "FEmusic_home" }, as); }
  catch (error) {
    // Google 原生 OAuth 能验证频道，但音乐网页可能拒绝该客户端的首页请求。
    // 仅公开发现页回退游客内容，不清除令牌，也不把个人资料库改为游客请求。
    if (!hasOAuth() || error.status !== 400) throw error;
    as = { ...remix, anonymous: true };
    answer = await call("browse", { browseId: "FEmusic_home" }, as);
  }
  const sections = await sectionsOf(answer, videosOnly);
  // It comes in a few pages. Two more make a page that's worth scrolling.
  let token = nextToken(findOne(answer, "sectionListRenderer"));
  for (let i = 0; token && i < 2; i++) {
    const more = await call("browse", { continuation: token }, as);
    sections.push(...(await sectionsOf(more, videosOnly)));
    token = nextToken(findOne(more, "sectionListContinuation"));
  }
  return sections;
}

export async function home() {
  return { title: t("Home"), sections: await discovery() };
}

const videoPreviewLength = 6;

async function videoCharts() {
  const answer = await publicBrowseId("FEmusic_charts");
  const shelf = findAll(answer, "musicCarouselShelfRenderer").find(item => /^(Video charts|视频排行榜)$/i.test(shelfTitle(item)));
  return ofKind(itemsOf(shelf?.contents), "playlist").map(item => ({
    title: item.name, imageUrl: item.imageUrl, page: `video-chart:${item.id}`,
  }));
}

async function videoHome() {
  const [fresh, charts] = await Promise.allSettled([
    publicBrowseId("FEmusic_new_releases").then(answer => sectionsOf(answer, true, videoPreviewLength)),
    videoCharts(),
  ]);
  let sections = fresh.status === "fulfilled" ? fresh.value : [];
  if (sections.length) {
    sections[0] = { ...sections[0], title: t("New Music Videos"), morePage: "videos:new" };
  } else {
    try { sections = await discovery(true); }
    catch (error) { if (error.code === "signIn") throw error; }
  }
  if (!sections.length) {
    if (fresh.status === "rejected" && charts.status === "rejected") throw fresh.reason;
    sections.push({ title: t("New Music Videos"), empty: t("No music videos on the current feed"), morePage: "videos:new" });
  }
  if (charts.status === "fulfilled" && charts.value.length) {
    sections.push({ title: t("Video Charts"), links: charts.value });
  } else if (charts.status === "rejected") {
    sections.push({ title: t("Video Charts"), links: [{ title: t("View Video Charts"), page: "videos:charts" }] });
  }
  return { title: t("Music Videos"), sections };
}

export async function browse({ page }) {
  if (page === "videos") return videoHome();
  if (page === "videos:new") {
    const title = t("New Music Videos");
    const sections = await sectionsOf(await publicBrowseId("FEmusic_new_releases_videos"), true);
    if (!sections.length) sections.push({ empty: t("No music videos on the current feed") });
    return { title, sections };
  }
  if (page === "videos:charts") {
    const links = await videoCharts();
    return { title: t("Video Charts"), sections: [{ links, empty: t("No music videos on the current feed") }] };
  }
  const chart = /^video-chart:((?:PL|OLAK)[\w-]{8,98})$/.exec(page);
  if (chart) {
    const answer = await publicBrowseId(`VL${chart[1]}`);
    const tracks = await withDurations(ofKind(videoItems(await playlistItems(answer, publicCall)), "track"));
    const title = textOf(headerOf(answer).title) || t("Video Charts");
    return { title, sections: [{ tracks, trackLayout: "videos", empty: t("No music videos on the current feed") }] };
  }
  const ids = { charts: ["FEmusic_charts", "Charts"], new: ["FEmusic_new_releases", "New Releases"] };
  const known = ids[page];
  if (known) return { title: t(known[1]), sections: await sectionsOf(await publicBrowseId(known[0])) };
  throw fail("unavailable", t("no such page"));
}

// Search. Each kind has its filter, which the website sends in this form.

const filters = {
  tracks: "EgWKAQIIAWoMEA4QChADEAQQCRAF",
  videos: "EgWKAQIQAWoMEA4QChADEAQQCRAF",
  albums: "EgWKAQIYAWoMEA4QChADEAQQCRAF",
  artists: "EgWKAQIgAWoMEA4QChADEAQQCRAF",
  playlists: "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D",
};

function linkedVideoID(query) {
  if (typeof query !== "string") return "";
  const value = query.trim();
  const short = /^https:\/\/youtu\.be\/([\w-]{11})(?:[?#][^\s]*)?$/i.exec(value);
  const watch = /^https:\/\/(?:(?:www|m|music)\.)?youtube\.com\/watch\?([^#\s]+)(?:#[^\s]*)?$/i.exec(value);
  return short?.[1] || (watch && /(?:^|&)v=([\w-]{11})(?:&|$)/.exec(watch[1])?.[1]) || "";
}

async function linkedVideo(id) {
  const result = await playerResponse(id);
  const detail = result.videoDetails;
  if (result.playabilityStatus?.status !== "OK" || !detail?.title || detail.isLiveContent || !videoFormats(result).length || !audioFormats(result).length) {
    throw fail("unavailable", result.playabilityStatus?.reason || t("No directly playable YouTube video"));
  }
  const duration = Number(detail.lengthSeconds);
  const credits = { artists: [], names: detail.author ? [detail.author] : [], duration: duration > 0 ? duration * 1000 : 0 };
  return { ...trackFrom(id, detail.title, credits, imageOf(detail.thumbnail, true), false, true), description: detail.shortDescription || undefined };
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const filter = filters[kind];
  if (!filter) return { [kind]: [], more: false };
  const id = (kind === "tracks" || kind === "videos") && linkedVideoID(query);
  if (id) return { tracks: offset > 0 ? [] : [await linkedVideo(id)], more: false };
  const key = `search\0${kind}\0${query}`;
  const token = pageToken(key, offset);
  if (offset > 0 && !token) return { [kind]: [], more: false };
  const answer = await publicCall("search", token ? { continuation: token } : { query, params: decodeURIComponent(filter) });
  const { items, token: next } = rowsOf(answer);
  const single = { tracks: "track", videos: "track", albums: "album", artists: "artist", playlists: "playlist" }[kind];
  const found = ofKind(kind === "videos" ? videoItems(items) : items, single);
  if (kind === "tracks" || kind === "videos") await withDurations(found);
  return { [kind === "videos" ? "tracks" : kind]: found, more: keepToken(key, offset + found.length, kind !== "videos" || found.length ? next : "") };
}

export function searchVideos({ query, offset = 0 }) {
  return search({ query, offset, kind: "videos" });
}

function exactCount(value) {
  if (typeof value !== "string" || !/^\d[\d,，\s]*$/.test(value)) return undefined;
  const count = Number(value.replace(/\D/g, ""));
  return Number.isSafeInteger(count) ? count : undefined;
}

const commentCounts = new Map();

export async function comments({ trackId, offset = 0 }) {
  if (!validVideoID(trackId)) throw fail("unavailable", "无效的 YouTube 视频 ID");
  const key = `comments\0${trackId}`;
  let continuation = pageToken(key, offset);
  if (offset === 0) {
    commentCounts.delete(trackId);
    const watch = await publicCall("next", { videoId: trackId });
    const tab = findAll(watch, "tabRenderer").find(item => /^(Comments|评论)$/i.test(item.title));
    continuation = tab?.content?.sectionListRenderer?.continuations?.[0]?.reloadContinuationData?.continuation;
  }
  if (!continuation) return { comments: [], more: false };

  const answer = await publicCall("next", { continuation });
  const actions = answer.onResponseReceivedEndpoints || [];
  const rows = actions.flatMap(action => {
    const batch = action.reloadContinuationItemsCommand || action.appendContinuationItemsAction;
    return batch?.targetId === trackId ? batch.continuationItems || [] : [];
  });
  const entities = new Map(findAll(answer.frameworkUpdates, "commentEntityPayload").map(item => [item.key, item]));
  const comments = [];
  const seen = new Set();
  for (const row of rows) {
    const view = row.commentThreadRenderer?.commentViewModel?.commentViewModel;
    const item = entities.get(view?.commentKey);
    const id = item?.properties?.commentId;
    const content = item?.properties?.content?.content;
    if (!id || typeof content !== "string" || !content.trim() || seen.has(id)) continue;
    seen.add(id);
    const avatar = item.author?.avatarThumbnailUrl;
    comments.push({ id, text: content, author: item.author?.displayName || "",
      avatarUrl: typeof avatar === "string" && avatar.startsWith("https://") ? avatar : undefined,
      likes: exactCount(item.toolbar?.likeCountNotliked) });
  }
  const header = rows.find(row => row.commentsHeaderRenderer)?.commentsHeaderRenderer;
  const count = [header?.commentsCount, header?.countText].map(value =>
    exactCount(textOf(value).trim().match(/^([\d,，\s]+)(?:comments?|条评论)?$/i)?.[1]?.trim())
  ).find(value => value !== undefined);
  if (count !== undefined) {
    if (commentCounts.size >= 32 && !commentCounts.has(trackId)) commentCounts.delete(commentCounts.keys().next().value);
    commentCounts.set(trackId, count);
  }
  const tail = rows.at(-1)?.continuationItemRenderer;
  const next = tail?.continuationEndpoint?.continuationCommand?.token;
  const more = comments.length > 0 && keepToken(key, offset + comments.length, next === continuation ? "" : next);
  return { comments, total: commentCounts.get(trackId), more };
}

export async function suggest({ query }) {
  const r = await publicCall("music/get_search_suggestions", { input: query });
  return findAll(r, "searchSuggestionRenderer").map((s) => textOf(s.suggestion)).filter(Boolean);
}

// Albums and artists.

function headerOf(answer) {
  return findOne(answer, "musicResponsiveHeaderRenderer") || findOne(answer, "musicDetailHeaderRenderer") || {};
}

async function albumPage({ id }) {
  const answer = await publicBrowseId(id);
  const header = headerOf(answer);
  const credits = creditsOf([...(header.straplineTextOne?.runs || []), ...(header.subtitle?.runs || [])]);
  const album = {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    artists: credits.artists,
    released: textOf(header.subtitle).match(/\b\d{4}\b/)?.[0],
  };
  const shelf = findOne(answer, "musicShelfRenderer");
  const tracks = ofKind(itemsOf(shelf?.contents), "track").map((t) => ({
    ...t,
    // An album's rows only name who's on them if that's someone else.
    artists: t.artists.length ? t.artists : album.artists,
    album: { id, name: album.name, imageUrl: album.imageUrl },
  }));
  return { album, tracks: await withDurations(tracks) };
}

async function artistPage({ id }) {
  const answer = await publicBrowseId(id);
  const header = findOne(answer, "musicImmersiveHeaderRenderer") || findOne(answer, "musicVisualHeaderRenderer") || {};
  const sections = await sectionsOf(answer);
  return {
    artist: { id, name: textOf(header.title), imageUrl: imageOf(header.thumbnail || header.foregroundThumbnail) },
    tracks: sections.flatMap((s) => s.tracks).slice(0, 20),
    albums: sections.flatMap((s) => s.albums),
  };
}

export { albumPage as album, artistPage as artist };

// Playlists and the library.

// A long playlist comes in pages: this many is thousands of songs.
const pagesAtMost = 30;

async function playlistItems(answer, request = call) {
  let { items, token } = rowsOf(answer);
  const out = [...items];
  for (let i = 0; token && i < pagesAtMost; i++) {
    ({ items, token } = rowsOf(await request("browse", { continuation: token })));
    out.push(...items);
  }
  return out;
}

async function playlistPage({ id }) {
  const answer = await publicBrowseId(`VL${id}`);
  const header = headerOf(answer);
  const tracks = await withDurations(ofKind(await playlistItems(answer, publicCall), "track"));
  return {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    description: textOf(findOne(header.description, "description") || header.description),
    owner: textOf(header.straplineTextOne),
    trackCount: tracks.length,
    tracks,
  };
}
export { playlistPage as playlist };

// The app loads this for its sidebar as it starts: no account is no playlists,
// rather than asking someone who's only browsing to sign in.
export async function playlists() {
  if (!hasSession()) return [];
  const items = (await sectionsOf(await browseId("FEmusic_liked_playlists"))).flatMap((s) => s.playlists);
  // Liked Music has an entry of its own, and episodes for later aren't songs.
  return items.filter((p) => p.id !== "LM" && p.id !== "SE").map((p) => ({ ...p, saved: true }));
}

export async function liked({ offset }) {
  needAccount();
  const token = pageToken("liked", offset);
  if (offset > 0 && !token) return { tracks: [], more: false };
  const answer = token ? await call("browse", { continuation: token }) : await browseId("VLLM");
  const { items, token: next } = rowsOf(answer);
  const tracks = await withDurations(ofKind(items, "track"));
  return { tracks, more: keepToken("liked", offset + tracks.length, next) };
}

// The service can't say of many songs at once which are liked, so the first few
// pages of liked songs answer, for a few minutes at a time.
let likedSet = null;
let likedAt = 0;
const likedFor = 5 * 60 * 1000;

async function likedIds() {
  if (likedSet && Date.now() - likedAt < likedFor) return likedSet;
  const set = new Set();
  let { items, token } = rowsOf(await browseId("VLLM"));
  for (let i = 0; ; i++) {
    for (const t of ofKind(items, "track")) set.add(t.id);
    if (!token || i >= 5) break;
    ({ items, token } = rowsOf(await call("browse", { continuation: token })));
  }
  likedSet = set;
  likedAt = Date.now();
  return set;
}

export async function isLiked({ ids }) {
  const set = hasSession() ? await likedIds() : new Set();
  return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
}

export async function like({ id, on }) {
  needAccount();
  await call(on ? "like/like" : "like/removelike", { target: { videoId: id } });
  if (likedSet) {
    if (on) likedSet.add(id);
    else likedSet.delete(id);
  }
}

export async function recent() {
  if (!hasSession()) return [];
  const sections = await sectionsOf(await browseId("FEmusic_history"));
  return sections.flatMap((s) => s.tracks).slice(0, 50);
}

// Radio: songs like the one last played.

const radio = { id: "radio", name: "Radio", description: "Songs like the one you played last." };

export function stations() {
  return [radio];
}

// What's played also goes in your history on YouTube Music, which its
// recommendations are made from, as its own player would put it there.
export async function played({ id }) {
  host.storage.set("lastPlayed", id);
  if (!hasSession()) return;
  try {
    await report(id);
  } catch (e) {
    console.warn(`reporting ${id} as played: ${e.message}`);
  }
}

async function report(id) {
  const r = await call("player", { videoId: id, playbackContext: { contentPlaybackContext: {} } });
  const base = r.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
  if (!base) throw new Error(t("YouTube gave no address to report it to"));
  const url = new URL(base);
  // The session goes with it, so it goes to YouTube alone.
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !["music.youtube.com", "www.youtube.com", "youtube.com", "s.youtube.com"].includes(url.hostname)) {
    throw new Error(`not sending your session to ${url.hostname}`);
  }
  url.searchParams.set("ver", "2");
  url.searchParams.set("c", "WEB_REMIX");
  url.searchParams.set("cpn", playbackNonce());
  const res = await fetch(url.href, {
    headers: { "user-agent": webUA, referer: `${site}/`, ...await authHeaders(url.origin) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

// The 16 characters a player sends to tell one playback from another.
function playbackNonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * 64)];
  return out;
}

function panelTrack(v) {
  const credits = creditsOf(v.longBylineText?.runs);
  credits.duration = msOf(textOf(v.lengthText));
  return trackFrom(v.videoId, textOf(v.title), credits, imageOf(v.thumbnail));
}

// Each batch starts from what's playing by then, so a radio drifts as a radio
// does. With nothing played yet, the first song of Home will do. Nothing to go
// on is an empty batch, which the app asks again for: Home isn't the same each time.
export async function stationNext() {
  let seed = host.storage.get("lastPlayed");
  if (!seed) {
    const { sections } = await home();
    seed = sections.flatMap((s) => s.tracks)[0]?.id;
    if (!seed) return [];
  }
  const answer = await call("next", { videoId: seed, playlistId: `RDAMVM${seed}`, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: "AUTOMIX_SETTING_NORMAL" });
  return findAll(answer, "playlistPanelVideoRenderer").filter((v) => v.videoId !== seed).map(panelTrack);
}

// Lyrics, which the app only shows when they're timed. Better Lyrics times each
// word, where YouTube times each line, so it goes first, and YouTube's are there
// for what it doesn't have.

export async function lyrics({ id }) {
  const next = await publicCall("next", { videoId: id, isAudioOnly: true }, android);
  const playing = findAll(next, "playlistPanelVideoRenderer").find((v) => v.videoId === id);
  const [better, own] = await Promise.allSettled([
    playing ? betterLyrics(panelTrack(playing)) : null,
    youtubeLyrics(next),
  ]);
  if (better.status === "rejected") console.warn(`Better Lyrics: ${better.reason?.message}`);
  if (better.value?.lines.length) return better.value;
  if (own.status === "rejected") throw own.reason;
  return own.value;
}

// Better Lyrics answers only for songs it has kept, and says so with a status:
// none, not kept, or too busy are all no lyrics.
async function betterLyrics(track) {
  const query = new URLSearchParams({ s: track.name, a: track.artists.map((a) => a.name).join(", ") });
  if (track.album.name) query.set("al", track.album.name);
  if (track.duration) query.set("d", String(Math.round(track.duration / 1000)));
  const res = await fetch(`https://api.betterlyrics.org/getLyrics?${query}`, {
    headers: { "user-agent": "MyGo Music (https://github.com/egoist/mygo-music)" },
  });
  if (!res.ok) return null;
  const lines = linesOfTTML((await res.json()).ttml || "");
  return lines.length ? { lines } : null;
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXML = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) =>
    e[0] !== "#" ? (entities[e] ?? all) : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

// A time as TTML writes it, such as 1:02.500 or 62.5, in milliseconds.
function clockOf(value) {
  if (!value) return null;
  const parts = value.trim().replace(/s$/, "").split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || !(Number(p) >= 0))) return null;
  return Math.round(parts.reduce((sum, p) => sum * 60 + Number(p), 0) * 1000);
}

const attrOf = (attrs, name) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// The lines of a TTML document: each <p> is a line, and each <span> in it with a
// time is a word, or part of one. The text between them is the spacing, which
// goes with the word before it. A span with no time only groups others, such
// as background vocals, and its words are the line's own.
function linesOfTTML(ttml) {
  const lines = [];
  for (const [, pAttrs, body] of ttml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const words = [];
    let text = "";
    let lead = ""; // what comes before the first word
    let word = null; // the word being read, and how many spans deep in it
    let depth = 0;
    for (const [, close, name, attrs, chars] of body.matchAll(/<(\/?)([\w:.-]+)([^>]*?)\/?>|([^<]+)/g)) {
      if (chars !== undefined) {
        const s = unescapeXML(chars);
        text += s;
        if (word) word.text += s;
        else if (words.length) words[words.length - 1].text += s;
        else lead += s;
        continue;
      }
      if (name !== "span") continue;
      if (close) {
        if (word && --depth === 0) {
          words.push(word);
          word = null;
        }
      } else if (word) {
        depth++;
      } else {
        const start = clockOf(attrOf(attrs, "begin"));
        if (start === null) continue;
        word = { start, end: clockOf(attrOf(attrs, "end")) ?? start, text: lead.trimStart() };
        lead = "";
        depth = 1;
      }
    }
    const start = clockOf(attrOf(pAttrs, "begin")) ?? words[0]?.start;
    const end = clockOf(attrOf(pAttrs, "end")) ?? words[words.length - 1]?.end ?? 0;
    text = text.replace(/\s+/g, " ").trim();
    // A line with no time can't be followed.
    if (text && start != null) lines.push({ start, end, text, words: words.length ? words : undefined });
  }
  return lines;
}

async function youtubeLyrics(next) {
  const lyricsId = findAll(next, "browseId").find((b) => /^MPLY/.test(b));
  if (!lyricsId) return { lines: [] };
  const r = await publicCall("browse", { browseId: lyricsId }, android);
  const timed = findOne(r, "timedLyricsData") || [];
  return {
    lines: timed
      .filter((l) => l.lyricLine)
      .map((l) => ({
        start: Number(l.cueRange?.startTimeMilliseconds) || 0,
        end: Number(l.cueRange?.endTimeMilliseconds) || 0,
        text: l.lyricLine,
      })),
  };
}

// MB iOS plays AAC/MP4 directly with AVFoundation; no desktop processes are needed.
let visitor = "";

async function visitorData() {
  if (visitor) return visitor;
  const result = await call("visitor_id", {}, { ...remix, anonymous: true });
  visitor = result.responseContext?.visitorData || "";
  if (!visitor) throw new Error(t("YouTube gave this visit no ID"));
  return visitor;
}

function mediaURL(value) {
  if (typeof value !== "string" || !/^https:\/\/(?:[a-z0-9-]+\.)+googlevideo\.com\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) return "";
  return value;
}

const cachedPlayer = playerCache();

export async function playerResponse(id, consumer = "metadata") {
  return cachedPlayer(id, () => visitorData().then(visitor => call("player", { videoId: id, contentCheckOk: true, racyCheckOk: true }, visionOS(visitor))), consumer);
}

function audioFormats(result) {
  return (result.streamingData?.adaptiveFormats || []).filter(format =>
    /^audio\/mp4\b/i.test(format.mimeType || "") && /mp4a/i.test(format.mimeType) && mediaURL(format.url) && !format.isDrc &&
    (!format.audioTrack || format.audioTrack.audioIsDefault));
}

function videoFormats(result) {
  return [...(result.streamingData?.formats || []), ...(result.streamingData?.adaptiveFormats || [])].filter(format =>
    /^video\/mp4\b/i.test(format.mimeType || "") && /\bavc[13]\./i.test(format.mimeType) && mediaURL(format.url) && Number(format.height) > 0);
}

export async function stream({ id, quality = "high" }) {
  if (!validVideoID(id)) throw fail("unavailable", "无效的 YouTube 视频 ID");
  const result = await playerResponse(id, "audio");
  const status = result.playabilityStatus || {};
  if (status.status !== "OK") throw fail("unavailable", status.reason || "YouTube 当前未提供可播放音频");
  const formats = audioFormats(result);
  if (!formats.length) throw fail("unavailable", "YouTube 当前未提供可直接播放的 AAC 音频");
  formats.sort((a, b) => Number(a.bitrate || 0) - Number(b.bitrate || 0));
  const selected = quality === "standard" ? formats[0] : formats[formats.length - 1];
  const loudness = result.playerConfig?.audioConfig?.trackAbsoluteLoudnessLkfs ?? result.playerConfig?.audioConfig?.perceptualLoudnessDb;
  return {
    url: mediaURL(selected.url), type: "m4a", quality: Number(selected.bitrate || 0) >= 128000 ? "high" : "standard",
    bitRate: Number(selected.bitrate) || undefined, size: Number(selected.contentLength) || undefined,
    gain: typeof loudness === "number" && loudness ? Math.round((-18 - loudness) * 100) / 100 : undefined,
    headers: { "User-Agent": visionUA },
  };
}

export async function video({ id, quality = "auto", network = {} }) {
  if (!validVideoID(id)) throw fail("unavailable", "无效的 YouTube 视频 ID");
  const result = await playerResponse(id, "video");
  const status = result.playabilityStatus || {};
  if (status.status !== "OK") throw fail("unavailable", status.reason || t("No directly playable YouTube video"));
  const formats = videoFormats(result);
  if (!formats.length) throw fail("unavailable", t("No directly playable YouTube video"));
  // 竖屏的 1080×1920 同样是 1080p；音乐音质不再把视频限制在 720p。
  const resolution = format => Math.min(Number(format.width) || Number(format.height), Number(format.height));
  const requested = /^(\d{2,4})p$/.exec(quality);
  const ceiling = quality === "standard" ? 360 : requested ? Number(requested[1]) : Infinity;
  formats.sort((left, right) => resolution(right) - resolution(left) ||
    Number(right.fps || 0) - Number(left.fps || 0) || Number(right.bitrate || 0) - Number(left.bitrate || 0));
  const selected = quality === "auto" || quality === "" ? automaticVideo(formats, network, resolution) :
    formats.find(format => resolution(format) <= ceiling) || formats.at(-1);
  const seen = new Set();
  const videoQualities = formats.flatMap(format => {
    const height = resolution(format), id = `${height}p`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: id + (Number(format.fps) > 30 ? Math.round(Number(format.fps)) : "") }];
  });
  return { url: selected.url, type: "mp4", headers: { "User-Agent": visionUA },
    videoQuality: `${resolution(selected)}p`, videoQualities };
}
