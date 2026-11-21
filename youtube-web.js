// YouTube 网页公开视频、Shorts 与字幕合同；配置从当前网页读取，不猜客户端版本。
import { playerResponse, authHeaders } from './music.js';
import { hasOAuth } from './oauth.js';
const site = 'https://www.youtube.com';
const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let configuration;
let feedVisitor;
let feedRevision = 0;
// YouTube.js Constants.CLIENTS.TV（2026-11-22 实测），原生授权仅在该客户端被推荐接口接受。
const tvClient = { clientName: 'TVHTML5', clientVersion: '7.20260311.12.00' };
export const videoId = value => typeof value === 'string' && /^[\w-]{11}$/.test(value);
export const text = value => typeof value === 'string' ? value : value?.simpleText || value?.content || value?.runs?.map(run => run.text).join('') || '';
export function find(node, key, out = []) {
  if (Array.isArray(node)) node.forEach(item => find(item, key, out));
  else if (node && typeof node === 'object') for (const [name, value] of Object.entries(node)) {
    if (name === key) out.push(value); else find(value, key, out);
  }
  return out;
}
export function embedded(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const begin = marker.endsWith('{') ? start + marker.length - 1 : html.indexOf('{', start + marker.length);
  const scriptEnd = html.indexOf('</script>', begin);
  if (scriptEnd >= 0) {
    const raw = html.slice(begin, scriptEnd).trim().replace(/\);?\s*$/, '').replace(/;\s*$/, '');
    try { return JSON.parse(raw); } catch { /* 同一脚本还有其他语句时走平衡扫描。 */ }
  }
  let depth = 0, quoted = false, escaped = false;
  for (let i = begin; i >= 0 && i < html.length; i++) {
    const char = html[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(begin, i + 1));
  }
  return null;
}
export async function webPage(path) {
  const res = await fetch(site + path, { headers: { 'user-agent': ua, 'accept-language': host.language() === 'zh-CN' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`YouTube 页面 HTTP ${res.status}`);
  return res.text();
}
export async function config() {
  if (!configuration) configuration = (async () => {
    const html = await webPage('/?hl=' + (host.language() === 'zh-CN' ? 'zh-CN' : 'en'));
    const value = embedded(html, 'ytcfg.set({') || embedded(html, 'ytcfg.set( {');
    if (!value?.INNERTUBE_CONTEXT?.client || !value.INNERTUBE_API_KEY) throw new Error('YouTube 网页配置不可用');
    return value;
  })().catch(error => { configuration = null; throw error; });
  return configuration;
}
export async function webCall(endpoint, body, authorization = {}) {
  if (!/^(browse|search|next|player|reel\/reel_watch_sequence|guide)$/.test(endpoint)) throw new Error('Unsupported YouTube endpoint');
  const c = await config();
  const res = await fetch(`${site}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json', 'user-agent': ua, origin: site,
      'x-youtube-client-name': String(c.INNERTUBE_CONTEXT_CLIENT_NAME || 1), 'x-youtube-client-version': c.INNERTUBE_CONTEXT.client.clientVersion },
    body: JSON.stringify({ context: c.INNERTUBE_CONTEXT, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube ${endpoint}: HTTP ${res.status}`);
  return res.json();
}
/** 推荐接口使用账号会话；公开视频搜索、字幕与播放器保持独立的公开请求。 */
export async function feedCall(endpoint, body) {
  if (!['browse', 'guide', 'reel/reel_watch_sequence'].includes(endpoint)) throw new Error('Unsupported feed endpoint');
  const generation = feedRevision, oauth = hasOAuth();
  const current = () => { if (generation !== feedRevision) throw new Error('登录状态已改变，请重新刷新'); };
  const authorization = await authHeaders(site); current();
  if (!oauth) { const result = await webCall(endpoint, body, authorization); current(); return result; }
  const context = { client: { ...tvClient, hl: host.language() === 'zh-CN' ? 'zh-CN' : 'en', ...(feedVisitor ? { visitorData: feedVisitor } : {}) }, user: { enableSafetyMode: false } };
  const res = await fetch(`${site}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json', origin: site,
      'user-agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version', 'x-youtube-client-name': '7', 'x-youtube-client-version': tvClient.clientVersion },
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube 账号推荐 ${endpoint}: HTTP ${res.status}`);
  const value = await res.json(); current();
  const login = value.responseContext?.serviceTrackingParams?.flatMap(item => item.params || []).find(item => item.key === 'logged_in');
  if (login?.value === '0') throw Object.assign(new Error('YouTube 推荐未接受账号授权，请重新登录'), { code: 'signIn' });
  feedVisitor = value.responseContext?.visitorData || feedVisitor;
  return value;
}
export function resetFeedSession() { feedRevision++; configuration = undefined; feedVisitor = undefined; }
const duration = value => /^\d+(?::\d+)+$/.test(value || '') ? value.split(':').reduce((n, p) => n * 60 + Number(p), 0) * 1000 : 0;
const thumb = node => find(node, 'thumbnails')[0]?.at(-1)?.url || find(node, 'sources')[0]?.at(-1)?.url;
function webTrack(row, shorts = false) {
  const endpoint = row.onTap?.innertubeCommand?.reelWatchEndpoint || row.navigationEndpoint?.reelWatchEndpoint;
  const id = row.videoId || endpoint?.videoId;
  if (!videoId(id)) return null;
  const title = text(row.title) || text(row.overlayMetadata?.primaryText);
  if (!title) return null;
  const byline = row.ownerText || row.longBylineText || row.shortBylineText;
  const channel = find(byline, 'browseEndpoint')[0]?.browseId;
  return { id, name: title, artists: [{ id: channel || '', name: text(byline) }],
    album: { id: '', name: '', imageUrl: thumb(row.thumbnail || row.thumbnailViewModel || endpoint?.thumbnail) },
    duration: duration(text(row.lengthText)), url: `${site}/${shorts ? 'shorts/' : 'watch?v='}${id}`,
    video: { width: shorts ? 9 : 16, height: shorts ? 16 : 9, short: shorts },
  };
}
function tileTrack(row) {
  if (!['TILE_CONTENT_TYPE_VIDEO', 'TILE_CONTENT_TYPE_SHORTS'].includes(row.contentType) || find(row, 'adBadgeViewModel').length) return null;
  const short = row.contentType === 'TILE_CONTENT_TYPE_SHORTS';
  const endpoint = find(row.onSelectCommand, short ? 'reelWatchEndpoint' : 'watchEndpoint')[0];
  if (!videoId(endpoint?.videoId)) return null;
  const metadata = row.metadata?.tileMetadataRenderer;
  const name = text(metadata?.title);
  if (!name) return null;
  const line = metadata?.lines?.[0]?.lineRenderer?.items?.map(item => text(item.lineItemRenderer?.text)).filter(Boolean).join(' ') || '';
  const menu = find(row.onLongPressCommand, 'showMenuCommand')[0];
  const artist = text(menu?.subtitle).split(' • ')[0] || line;
  const channel = find(row, 'browseEndpoint').find(item => item.browseId?.startsWith('UC'))?.browseId || '';
  const pictures = (short ? endpoint.thumbnail?.thumbnails : undefined) || row.header?.tileHeaderRenderer?.thumbnail?.thumbnails || [];
  const picture = pictures.at(-1);
  return { id: endpoint.videoId, name, artists: [{ id: channel, name: artist }], album: { id: '', name: '', imageUrl: picture?.url },
    duration: duration(text(find(row.header, 'thumbnailOverlayTimeStatusRenderer')[0]?.text)),
    url: `${site}/${short ? 'shorts/' : 'watch?v='}${endpoint.videoId}`, video: { width: short ? picture?.width || 9 : 16, height: short ? picture?.height || 16 : 9, short } };
}
function lockupTrack(row) {
  if (row.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !videoId(row.contentId)) return null;
  const metadata = row.metadata?.lockupMetadataViewModel;
  const name = text(metadata?.title); if (!name) return null;
  const parts = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(item => item.metadataParts || []) || [];
  const author = parts[0]?.text;
  const channel = find(author, 'browseEndpoint').find(item => item.browseId?.startsWith('UC'))?.browseId || '';
  return { id: row.contentId, name, artists: [{ id: channel, name: text(author) }], album: { id: '', name: '', imageUrl: thumb(row.contentImage) },
    duration: duration(text(find(row.contentImage, 'thumbnailOverlayBadgeViewModel')[0]?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text)),
    url: `${site}/watch?v=${row.contentId}`, video: { width: 16, height: 9, short: false } };
}
export function videos(answer, onlyShorts = false) {
  const items = [];
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, row] of Object.entries(value)) {
      if (['adSlotRenderer', 'inFeedAdLayoutRenderer', 'promotedSparklesWebRenderer', 'adClientParams'].includes(key)) continue;
      if (key === 'tileRenderer' || key === 'lockupViewModel') {
        const track = key === 'tileRenderer' ? tileTrack(row) : lockupTrack(row);
        if (track && (!onlyShorts || track.video.short)) items.push(track);
        continue;
      }
      const short = key === 'shortsLockupViewModel' || key === 'reelItemRenderer';
      if (short || key === 'videoRenderer' || key === 'compactVideoRenderer' || key === 'gridVideoRenderer' || key === 'playlistVideoRenderer') {
        if (!onlyShorts || short) { const track = webTrack(row, short); if (track) items.push(track); }
      } else visit(row);
    }
  }
  visit(answer);
  return items.filter((track, index) => items.findIndex(item => item.id === track.id) === index);
}
export const continuation = answer => find(answer, 'continuationItemRenderer').map(item => item.continuationEndpoint?.continuationCommand?.token).find(Boolean);
const pendingPlayers = new Map();
export async function watch(id) {
  if (!videoId(id)) throw new Error('无效的 YouTube 视频 ID');
  if (!pendingPlayers.has(id)) pendingPlayers.set(id, (async () => {
    const html = await webPage('/watch?v=' + id);
    const player = embedded(html, 'var ytInitialPlayerResponse =');
    if (!player?.videoDetails) throw new Error('YouTube 未返回视频信息');
    return { player, initial: embedded(html, 'var ytInitialData =') };
  })());
  try { return await pendingPlayers.get(id); } finally { pendingPlayers.delete(id); }
}
export async function captions(id) {
  let player;
  try { player = await playerResponse(id); } catch { player = (await watch(id)).player; }
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const language = host.language() === 'zh-CN' ? 'zh' : 'en';
  const track = tracks.find(item => item.languageCode?.startsWith(language) && item.kind !== 'asr') ||
    tracks.find(item => item.languageCode?.startsWith(language)) || tracks.find(item => item.kind !== 'asr') || tracks[0];
  if (!track) return { lines: [] };
  const url = new URL(track.baseUrl);
  if (url.origin !== site || url.pathname !== '/api/timedtext') throw new Error('无效的 YouTube 字幕地址');
  url.searchParams.set('fmt', 'json3');
  const res = await fetch(url.href, { headers: { 'user-agent': ua } });
  if (!res.ok) throw new Error(`YouTube 字幕 HTTP ${res.status}`);
  const raw = await res.text();
  if (!raw.trim()) throw new Error('YouTube 暂未返回字幕内容，请稍后重试');
  const data = JSON.parse(raw);
  return { lines: (data.events || []).filter(event => Number.isFinite(event.tStartMs) && event.segs?.length).map(event => ({
    start: event.tStartMs, end: event.tStartMs + (event.dDurationMs || 4000), text: event.segs.map(seg => seg.utf8 || '').join('').replace(/\n/g, ' ').trim(),
  })).filter(line => line.text) };
}
export async function webComments(trackId, token) {
  if (!token) {
    const initial = await webCall('next', { videoId: trackId });
    const section = find(initial, 'itemSectionRenderer').find(item => item.sectionIdentifier === 'comment-item-section');
    token = continuation(section);
    if (!token) return { comments: [], more: false };
  }
  const answer = await webCall('next', { continuation: token });
  const entities = new Map(find(answer.frameworkUpdates, 'commentEntityPayload').map(item => [item.key, item]));
  const batches = [...(answer.onResponseReceivedEndpoints || []), ...(answer.onResponseReceivedActions || [])]
    .map(item => item.reloadContinuationItemsCommand || item.appendContinuationItemsAction).filter(Boolean);
  const rows = batches.filter(item => item.targetId === 'comments-section').flatMap(item => item.continuationItems || []);
  const comments = rows.flatMap(row => {
    const thread = row.commentThreadRenderer;
    if (!thread) return [];
    const entity = entities.get(thread.commentViewModel?.commentViewModel?.commentKey);
    const legacy = thread.comment?.commentRenderer;
    const id = entity?.properties?.commentId || legacy?.commentId;
    const content = entity?.properties?.content?.content || text(legacy?.contentText);
    if (!id || !content) return [];
    return [{ id, text: content, author: entity?.author?.displayName || text(legacy?.authorText),
      avatarUrl: entity?.author?.avatarThumbnailUrl || thumb(legacy?.authorThumbnail),
      likes: /^\d[\d,]*$/.test(entity?.toolbar?.likeCountNotliked || '') ? Number(entity.toolbar.likeCountNotliked.replaceAll(',', '')) : Number(legacy?.voteCount?.simpleText?.replaceAll(',', '')) || 0 }];
  });
  const tail = rows.at(-1)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
  return { comments, next: tail !== token ? tail : undefined, more: Boolean(comments.length && tail && tail !== token) };
}
