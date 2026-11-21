// YouTube 账号首页、服务端分类与 Shorts：保留真实分组和续页，禁止用搜索或热门榜替代推荐。
import { hasOAuth } from './oauth.js';
import { feedCall, webPage, videos, continuation, embedded, videoId, text, find, resetFeedSession } from './youtube-web.js';
import { playerResponse } from './music.js';

const title = (cn, en) => host.language() === 'zh-CN' ? cn : en;
const pagesKey = 'youtube.feed.pages.v1';
let homeRequest, homeTime = 0, guideRequest, revision = 0;
const tracksIn = page => page.sections.reduce((count, section) => count + (section.tracks?.length || 0), 0);
const tokenIn = node => node?.continuations?.[0]?.nextContinuationData?.continuation || continuation(node);
const sectionTitle = shelf => text(shelf.title) || text(shelf.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title);
const sectionList = answer => find(answer.contents, 'sectionListRenderer')[0] || answer.continuationContents?.sectionListContinuation;
const listIn = shelf => shelf.content?.horizontalListRenderer || shelf.content?.expandedShelfContentsRenderer || shelf.content?.richShelfRenderer;
const shortsShelf = shelf => shelf.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' || find(shelf, 'reelWatchEndpoint').length > 0;
function active(generation) { if (generation !== revision) throw new Error('登录状态已改变，请重新刷新'); }
const nextPage = (request, name) => 'yt-feed:' + encodeURIComponent(JSON.stringify({ request, title: name }));

export function resetFeeds() {
  revision++; homeRequest = undefined; guideRequest = undefined; homeTime = 0;
  host.storage.set(pagesKey, {}); resetFeedSession();
}
function remember(key, offset, next, seen = []) {
  const pages = host.storage.get(pagesKey) || {};
  if (offset === 0) for (const item of Object.keys(pages)) if (item.startsWith(key + ':')) delete pages[item];
  if (next) pages[`${key}:${offset}`] = { ...next, seen: seen.slice(-1000) };
  else delete pages[`${key}:${offset}`];
  const keys = Object.keys(pages); for (const old of keys.slice(0, Math.max(0, keys.length - 64))) delete pages[old];
  host.storage.set(pagesKey, pages);
  return Boolean(next);
}
function prior(key, offset) { return offset > 0 ? host.storage.get(pagesKey)?.[`${key}:${offset}`] : undefined; }
async function loadHome(fresh = false) {
  if (fresh || !homeRequest || Date.now() - homeTime > 30_000) {
    const generation = revision; homeTime = Date.now();
    const pending = feedCall('browse', { browseId: 'FEwhat_to_watch' }).then(answer => {
      if (generation !== revision) throw new Error('登录状态已改变，请重新刷新');
      return answer;
    }).catch(error => { if (homeRequest === pending) homeRequest = undefined; throw error; });
    homeRequest = pending;
  }
  return homeRequest;
}
async function tabs() {
  if (!hasOAuth()) return [];
  const generation = revision;
  if (!guideRequest) {
    const pending = feedCall('guide', {}).catch(error => { if (guideRequest === pending) guideRequest = undefined; throw error; });
    guideRequest = pending;
  }
  let guide;
  try { guide = await guideRequest; }
  catch (error) { active(generation); if (error.code === 'signIn') throw error; return []; }
  active(generation);
  const entries = find(guide.items, 'guideEntryRenderer').flatMap(item => {
    const endpoint = item.navigationEndpoint?.browseEndpoint;
    if (!/^FEtopics(?:_[a-z]+)?$/.test(endpoint?.browseId || '')) return [];
    const name = endpoint.browseId === 'FEtopics' ? title('全部', 'All') : text(item.formattedTitle);
    return name ? [{ title: name, page: endpoint.browseId === 'FEtopics' ? 'feed:home' : nextPage({ browseId: endpoint.browseId }, name) }] : [];
  });
  return entries.filter((item, index) => entries.findIndex(other => other.page === item.page) === index);
}
function sectionsOf(answer, fallbackTitle) {
  const list = sectionList(answer);
  const shelves = list ? find(list.contents, 'shelfRenderer') : [];
  if (shelves.length) return shelves.flatMap(shelf => {
    const tracks = videos(listIn(shelf));
    if (!tracks.length) return [];
    const name = sectionTitle(shelf) || fallbackTitle;
    const token = tokenIn(listIn(shelf));
    return [{ title: name, tracks, trackLayout: 'videos', ...(token ? { morePage: nextPage({ continuation: token }, name) } : {}) }];
  });
  const items = answer.continuationContents?.horizontalListContinuation || answer;
  const tracks = videos(items);
  if (!tracks.length) return [];
  const normal = tracks.filter(track => !track.video.short), short = tracks.filter(track => track.video.short);
  return [normal.length ? { title: fallbackTitle, tracks: normal, trackLayout: 'videos' } : null,
    short.length ? { title: 'Shorts', tracks: short, trackLayout: 'videos' } : null].filter(Boolean);
}
function pageOf(answer, name) {
  const sections = sectionsOf(answer, name);
  if (!sections.length) sections.push({ title: name, tracks: [], empty: title('YouTube 暂未返回推荐内容，请登录或稍后下拉刷新', 'YouTube returned no recommendations. Sign in or pull to refresh later.') });
  return { title: name, sections };
}
export async function home() {
  const generation = revision;
  remember('feed:home', 0);
  const answer = await loadHome(true);
  const page = pageOf(answer, title('推荐视频', 'Recommended Videos'));
  const filters = await tabs(); active(generation);
  return { ...page, title: 'YouTube', tabs: filters, selectedTab: 'feed:home' };
}
function decode(page) {
  if (page === 'feed:home' || page === 'category:all') return { request: { browseId: 'FEwhat_to_watch' }, title: title('推荐视频', 'Recommended Videos') };
  let value;
  try { value = JSON.parse(decodeURIComponent(page.slice(8))); } catch { throw new Error('分类地址已失效，请返回首页刷新'); }
  const request = value?.request;
  if (!request || typeof value.title !== 'string' || value.title.length > 256 || Object.keys(request).length !== 1 ||
      !(typeof request.continuation === 'string' && request.continuation.length <= 32768 || /^FEtopics(?:_[a-z]+)?$/.test(request.browseId || ''))) throw new Error('无效的 YouTube 推荐分类');
  return value;
}
export async function browse({ page, offset = 0 }) {
  if (page === 'shorts') return shorts(offset);
  const generation = revision;
  if (offset === 0) remember(page, 0);
  const route = decode(page), previous = prior(page, offset);
  if (offset > 0 && !previous) return { title: route.title, sections: [], more: false };
  const request = previous ? { continuation: previous.token } : route.request;
  const answer = await feedCall('browse', request);
  const result = pageOf(answer, route.title);
  const list = sectionList(answer) || answer.continuationContents?.horizontalListContinuation;
  const next = tokenIn(list);
  const count = tracksIn(result);
  const filters = route.request.browseId ? await tabs() : []; active(generation);
  return { ...result, tabs: filters, selectedTab: page,
    more: count > 0 && next !== request.continuation && remember(page, offset + count, next ? { token: next } : undefined) };
}
function sequenceToken(answer) {
  return typeof answer.continuation === 'string' ? answer.continuation : answer.continuationEndpoint?.continuationCommand?.token;
}
async function sequenceTracks(answer) {
  const endpoints = (answer.entries || []).map(item => item.command?.reelWatchEndpoint)
    .filter(item => videoId(item?.videoId) && !item.adClientParams?.isAd && item.videoType !== 'REEL_VIDEO_TYPE_AD');
  const tracks = [];
  for (let i = 0; i < endpoints.length; i += 3) {
    const batch = await Promise.all(endpoints.slice(i, i + 3).map(async endpoint => {
      try {
        const details = endpoint.unserializedPrefetchData?.playerResponse?.videoDetails || (await playerResponse(endpoint.videoId)).videoDetails;
        if (!details?.title) return null;
        const image = endpoint.thumbnail?.thumbnails?.at(-1) || details.thumbnail?.thumbnails?.at(-1);
        return { id: endpoint.videoId, name: details.title, artists: [{ id: details.channelId || '', name: details.author || '' }],
          album: { id: '', name: '', imageUrl: image?.url }, duration: (Number(details.lengthSeconds) || 0) * 1000,
          url: 'https://www.youtube.com/shorts/' + endpoint.videoId, video: { width: image?.width || 9, height: image?.height || 16, short: true } };
      } catch { return null; }
    }));
    tracks.push(...batch.filter(Boolean));
  }
  if (endpoints.length && !tracks.length) throw new Error('Shorts 视频信息暂时不可用，请重试');
  return tracks;
}
async function shorts(offset) {
  const generation = revision, key = 'shorts';
  if (offset === 0) remember(key, 0);
  const previous = prior(key, offset);
  if (offset > 0 && !previous) return { title: 'Shorts', sections: [], more: false };
  let tracks, next;
  if (!previous) {
    const answer = await loadHome();
    const shelf = find(sectionList(answer)?.contents || answer.contents, 'shelfRenderer').find(shortsShelf);
    tracks = shelf ? videos(listIn(shelf), true) : videos(answer, true);
    const token = tokenIn(listIn(shelf || {}));
    if (token) next = { kind: 'browse', token };
    if (!tracks.length) {
      // 游客只使用 YouTube 自己给出的 Shorts 序列，不借搜索伪造短视频。
      const initial = embedded(await webPage('/shorts/'), 'var ytInitialData =');
      const sequence = find(initial, 'sequenceContinuation')[0];
      if (!sequence) throw new Error(title('YouTube 暂未提供 Shorts 信息流', 'YouTube did not return a Shorts feed'));
      const result = await feedCall('reel/reel_watch_sequence', { sequenceParams: sequence });
      tracks = await sequenceTracks(result); const tail = sequenceToken(result);
      if (tail) next = { kind: 'sequence', token: tail };
    }
  } else if (previous.kind === 'browse') {
    const answer = await feedCall('browse', { continuation: previous.token });
    tracks = videos(answer.continuationContents?.horizontalListContinuation || answer, true);
    const token = tokenIn(answer.continuationContents?.horizontalListContinuation || answer);
    if (token && token !== previous.token) next = { kind: 'browse', token };
  } else {
    const answer = await feedCall('reel/reel_watch_sequence', { sequenceParams: previous.token });
    tracks = await sequenceTracks(answer); const token = sequenceToken(answer);
    if (token && token !== previous.token) next = { kind: 'sequence', token };
  }
  active(generation);
  const seen = new Set(previous?.seen || []);
  tracks = tracks.filter(track => !seen.has(track.id) && seen.add(track.id));
  return { title: 'Shorts', sections: [{ title: 'Shorts', tracks, trackLayout: 'videos', empty: title('暂无 Shorts', 'No Shorts') }],
    more: tracks.length > 0 && remember(key, offset + tracks.length, next, [...seen]) };
}
