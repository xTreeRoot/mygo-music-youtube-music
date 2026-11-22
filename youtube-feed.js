// YouTube 账号首页、服务端分类与 Shorts：保留真实分组和续页，禁止用搜索或热门榜替代推荐。
import { hasOAuth } from './oauth.js';
import { feedCall, webPage, videos, continuation, embedded, videoId, text, find, resetFeedSession } from './youtube-web.js';
import { playerResponse } from './music.js';
import { api, apiTracks } from './youtube-api.js';

const title = (cn, en) => host.language() === 'zh-CN' ? cn : en;
const pagesKey = 'youtube.feed.pages.v1';
const shelvesKey = 'youtube.feed.shelves.v1';
let homeRequest, homeTime = 0, guideRequest, revision = 0;
const tracksIn = page => page.sections.reduce((count, section) => count + (section.tracks?.length || 0), 0);
const tokenIn = node => node?.continuations?.[0]?.nextContinuationData?.continuation || continuation(node);
const sectionTitle = shelf => text(shelf.title) || text(shelf.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title);
const sectionList = answer => find(answer.contents, 'sectionListRenderer')[0] || answer.continuationContents?.sectionListContinuation;
const listIn = shelf => shelf.content?.horizontalListRenderer || shelf.content?.expandedShelfContentsRenderer || shelf.content?.richShelfRenderer;
const shortsShelf = shelf => shelf.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' || find(shelf, 'reelWatchEndpoint').length > 0;
function active(generation) { if (generation !== revision) throw new Error('登录状态已改变，请重新刷新'); }
const nextPage = (request, name, shelf = false) => 'yt-feed:' + encodeURIComponent(JSON.stringify({ request, title: name, ...(shelf ? { shelf: true } : {}) }));

export function resetFeeds() {
  revision++; homeRequest = undefined; guideRequest = undefined; homeTime = 0;
  host.storage.set(pagesKey, {}); host.storage.set(shelvesKey, {}); resetFeedSession();
}
/** 保存栏目的真实首屏和独立游标；“更多”从首屏开始，续页不再返回整个首页。 */
function shelfPage(token, name, tracks, sourcePage) {
  const route = nextPage({ continuation: token }, name, true);
  const saved = host.storage.get(shelvesKey) || {};
  saved[route] = { title: name, tracks, trackLayout: 'videos', sourcePage, continuation: token };
  for (const key of Object.keys(saved).slice(0, -32)) delete saved[key];
  host.storage.set(shelvesKey, saved);
  return route;
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
  const categories = [
    ['FEtopics', title('全部', 'All')], ['FEtopics_music', title('音乐', 'Music')],
    ['FEtopics_podcasts', title('播客', 'Podcasts')], ['FEtopics_gaming', title('游戏', 'Gaming')],
  ];
  const entries = find(guide.items, 'guideEntryRenderer').flatMap(item => {
    const endpoint = item.navigationEndpoint?.browseEndpoint;
    const category = categories.find(([id]) => id === endpoint?.browseId);
    if (!category) return [];
    return [{ title: category[1], page: endpoint.browseId === 'FEtopics' ? 'feed:home' : nextPage({ browseId: endpoint.browseId }, category[1]) }];
  });
  return categories.flatMap(([, name]) => entries.find(item => item.title === name) || []);
}
function sectionsOf(answer, fallbackTitle, sourcePage) {
  const list = sectionList(answer);
  const shelves = list ? find(list.contents, 'shelfRenderer') : [];
  if (shelves.length) return shelves.flatMap(shelf => {
    const tracks = videos(listIn(shelf)), declared = sectionTitle(shelf);
    if (!tracks.length && !declared && !shortsShelf(shelf)) return [];
    const name = shortsShelf(shelf) ? 'Shorts' : declared || fallbackTitle;
    const token = tokenIn(listIn(shelf));
    return [{ title: name, tracks, trackLayout: 'videos', ...(token ? { morePage: shelfPage(token, name, tracks, sourcePage) } : {}) }];
  });
  const items = answer.continuationContents?.horizontalListContinuation || answer;
  const tracks = videos(items);
  if (!tracks.length) return [];
  const normal = tracks.filter(track => !track.video.short), short = tracks.filter(track => track.video.short);
  return [normal.length ? { title: fallbackTitle, tracks: normal, trackLayout: 'videos' } : null,
    short.length ? { title: 'Shorts', tracks: short, trackLayout: 'videos' } : null].filter(Boolean);
}
function pageOf(answer, name, sourcePage) {
  const sections = sectionsOf(answer, name, sourcePage);
  if (!sections.length) sections.push({ title: name, tracks: [], empty: title('YouTube 暂未返回推荐内容，请登录或稍后下拉刷新', 'YouTube returned no recommendations. Sign in or pull to refresh later.') });
  return { title: name, sections };
}
export async function home({ sectionIds } = {}) {
  const generation = revision;
  remember('feed:home', 0);
  const groups = [
    { id: 'music', title: title('推荐音乐视频', 'Recommended Music Videos'), matches: name => /^(推荐的?音乐视频|recommended music videos|music videos for you)$/i.test(name) },
    { id: 'shorts', title: 'Shorts', matches: name => name === 'Shorts' },
    { id: 'recommended', title: title('推荐视频', 'Recommended Videos'), matches: name => /^(推荐视频|为你推荐|recommended(?: videos)?|for you)$/i.test(name) },
  ].filter(group => !sectionIds || sectionIds.includes(group.id));
  if (!groups.length) return { title: "YouTube", sections: [], more: false };
  const found = new Map(), seen = new Set();
  const collect = answer => {
    for (const section of sectionsOf(answer, title('推荐视频', 'Recommended Videos'), 'feed:home')) {
      const group = groups.find(item => item.matches(section.title));
      if (group && !found.has(group.title)) found.set(group.title, { ...section, title: group.title });
    }
  };
  let answer = await loadHome(true); active(generation); collect(answer);
  // 所需栏目可能在首页的后续响应；切回“全部”与首次进入必须走相同完整加载流程。
  for (let i = 0; i < 2 && found.size < groups.length; i++) {
    const token = tokenIn(sectionList(answer));
    if (!token || seen.has(token)) break;
    seen.add(token);
    try { answer = await feedCall('browse', { continuation: token }); active(generation); collect(answer); }
    catch (error) { active(generation); if (error.code === 'signIn') throw error; break; }
  }
  const filters = await tabs(); active(generation);
  // 只读取服务端实际声明的音乐分类中的同名推荐栏目，不用搜索或榜单填充。
  const music = filters.find(item => decode(item.page).request.browseId === 'FEtopics_music');
  if (groups.some(group => group.id === 'music') && !found.has(groups.find(group => group.id === 'music').title) && music) {
    try { const answer = await feedCall('browse', decode(music.page).request); active(generation); collect(answer); }
    catch (error) { active(generation); if (error.code === 'signIn') throw error; }
  }
  if (groups.some(group => group.id === 'shorts') && !found.has('Shorts')) {
    try {
      const page = await shorts(0); active(generation);
      const section = page.sections.find(item => item.tracks.length);
      if (section) found.set('Shorts', { ...section, ...(page.more ? { morePage: 'shorts' } : {}) });
    } catch (error) { active(generation); if (error.code === 'signIn') throw error; }
  }
  const sections = groups.map(group => found.get(group.title) || { title: group.title, tracks: [], trackLayout: 'videos',
    empty: title('YouTube 暂未返回推荐内容，请登录或稍后下拉刷新', 'YouTube returned no recommendations. Sign in or pull to refresh later.') });
  return { title: 'YouTube', sections, tabs: filters, selectedTab: 'feed:home', more: false };
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
export async function browse({ page, offset = 0, refresh = false }) {
  if (page === 'shorts') return shorts(offset, refresh);
  if (page === 'feed:home' || page === 'category:all') return offset === 0 ? home() : { title: 'YouTube', sections: [], more: false };
  const generation = revision;
  const route = decode(page), previous = prior(page, offset);
  if (route.shelf) return browseShelf(page, route, offset, previous, generation, refresh);
  if (offset > 0 && !previous) return { title: route.title, sections: [], more: false };
  const request = previous ? { continuation: previous.token } : route.request;
  const answer = await feedCall('browse', request);
  const result = pageOf(answer, route.title, page);
  const list = sectionList(answer) || answer.continuationContents?.horizontalListContinuation;
  const next = tokenIn(list);
  const count = tracksIn(result);
  const filters = route.request.browseId ? await tabs() : []; active(generation);
  if (offset === 0) remember(page, 0);
  return { ...result, tabs: filters, selectedTab: page,
    more: count > 0 && next !== request.continuation && remember(page, offset + count, next ? { token: next } : undefined) };
}

/** TV 的栏目续页既可能直接给横向列表，也可能仍给整页栏目；按原标题提取并跨页去重。 */
async function browseShelf(page, route, offset, previous, generation, refresh) {
  if (offset === 0) {
    let first = host.storage.get(shelvesKey)?.[page];
    if (!first) throw new Error(title('栏目预览已失效，请返回首页刷新', 'This shelf has expired. Refresh the homepage.'));
    if (refresh) {
      const sourcePage = first.sourcePage || 'feed:home';
      const parent = await browse({ page: sourcePage, refresh: true }); active(generation);
      const normalized = name => name.toLowerCase().replace(/的|\s/g, '');
      const current = parent.sections.find(section => [section.title,
        section.morePage?.startsWith('yt-feed:') ? decode(section.morePage).title : '']
        .some(name => normalized(name) === normalized(route.title)));
      if (!current) throw new Error(title('YouTube 本次未返回该栏目，请稍后刷新', 'YouTube did not return this shelf. Try refreshing later.'));
      first = { title: current.title, tracks: current.tracks, trackLayout: 'videos', sourcePage,
        continuation: current.morePage === 'shorts' ? null : current.morePage ? decode(current.morePage).request.continuation || null : null,
        delegate: current.morePage === 'shorts' ? 'shorts' : null };
      const saved = host.storage.get(shelvesKey) || {}; saved[page] = first; host.storage.set(shelvesKey, saved);
    }
    const count = first.tracks.length, token = 'continuation' in first ? first.continuation : route.request.continuation;
    const next = first.delegate ? { delegate: first.delegate } : token ? { token } : undefined;
    remember(page, 0);
    return { title: route.title, sections: [{ title: first.title, tracks: first.tracks, trackLayout: 'videos' }],
      more: count > 0 && remember(page, count, next, first.tracks.map(track => track.id)) };
  }
  if (!previous) return { title: route.title, sections: [], more: false };
  if (previous.delegate === 'shorts') {
    const result = await shorts(offset); active(generation);
    if (result.more) remember(page, offset + tracksIn(result), { delegate: 'shorts' });
    return result;
  }
  const seen = new Set(previous.seen || []), consumed = new Set();
  const sameTitle = name => name.toLowerCase().replace(/的|\s/g, '') === route.title.toLowerCase().replace(/的|\s/g, '');
  let token = previous.token, tracks = [], next;
  for (let attempt = 0; attempt < 3 && token && !consumed.has(token); attempt++) {
    consumed.add(token);
    const answer = await feedCall('browse', { continuation: token }); active(generation);
    const list = sectionList(answer);
    const shelf = list ? find(list.contents, 'shelfRenderer').find(item => sameTitle(shortsShelf(item) ? 'Shorts' : sectionTitle(item))) : undefined;
    const horizontal = shelf ? listIn(shelf) : answer.continuationContents?.horizontalListContinuation;
    // 整页中找不到当前栏目时，不把其他推荐栏目冒充该栏目的后续数据。
    tracks = videos(horizontal || (list ? null : answer)).filter(track => !seen.has(track.id) && seen.add(track.id));
    next = tokenIn(horizontal) || list?.continuations?.[0]?.nextContinuationData?.continuation;
    if (next === token || consumed.has(next)) next = undefined;
    if (tracks.length || !next) break;
    token = next;
  }
  if (!tracks.length && next) throw new Error(title('YouTube 暂未返回更多该栏目内容，请重试', 'YouTube returned no new items in this shelf. Try again.'));
  return { title: route.title, sections: [{ title: route.title, tracks, trackLayout: 'videos' }],
    more: tracks.length > 0 && remember(page, offset + tracks.length, next ? { token: next } : undefined, [...seen]) };
}
function sequenceToken(answer) {
  return typeof answer.continuation === 'string' ? answer.continuation : answer.continuationEndpoint?.continuationCommand?.token;
}
async function sequenceTracks(answer) {
  const endpoints = (answer.entries || []).map(item => item.command?.reelWatchEndpoint)
    .filter(item => videoId(item?.videoId) && !item.adClientParams?.isAd && item.videoType !== 'REEL_VIDEO_TYPE_AD');
  if (hasOAuth() && endpoints.length) {
    // 序列通常只含 ID；账号元数据批量读取正式 API，不依赖可能要求再次登录的公开视频播放器。
    const details = new Map();
    for (let i = 0; i < endpoints.length; i += 50) {
      const result = await api('videos', { part: 'snippet,contentDetails', id: endpoints.slice(i, i + 50).map(item => item.videoId).join(',') });
      for (const track of apiTracks(result)) details.set(track.id, track);
    }
    return endpoints.flatMap(endpoint => {
      const track = details.get(endpoint.videoId);
      if (!track) return [];
      const image = endpoint.thumbnail?.thumbnails?.at(-1);
      return [{ ...track, album: { ...track.album, imageUrl: image?.url || track.album.imageUrl },
        url: 'https://www.youtube.com/shorts/' + track.id, video: { width: image?.width || 9, height: image?.height || 16, short: true } }];
    });
  }
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
async function shorts(offset, refresh = false) {
  const generation = revision, key = 'shorts';
  const previous = prior(key, offset);
  if (offset > 0 && !previous) return { title: 'Shorts', sections: [], more: false };
  let tracks, next;
  if (!previous) {
    const answer = await loadHome(refresh);
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
  if (offset === 0) remember(key, 0);
  const seen = new Set(previous?.seen || []);
  tracks = tracks.filter(track => !seen.has(track.id) && seen.add(track.id));
  return { title: 'Shorts', sections: [{ title: 'Shorts', tracks, trackLayout: 'videos', empty: title('暂无 Shorts', 'No Shorts') }],
    more: tracks.length > 0 && remember(key, offset + tracks.length, next, [...seen]) };
}
