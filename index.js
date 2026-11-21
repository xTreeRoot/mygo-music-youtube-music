// MB YouTube 平台入口：完整视频、Shorts、分类和账号；音乐专区保留为独立入口。
import * as music from './music.js';
import { hasOAuth } from './oauth.js';
import { api, apiTracks, officialComments, channelUploads, subscribedVideos, thumbnail } from './youtube-api.js';
import { webCall, webPage, videos, continuation, embedded, videoId, text, find, captions, webComments } from './youtube-web.js';
export { stream, video } from './music.js';
export async function signIn() { cursors.clear(); return music.signIn({ commentAccess: true }); }
export async function account() { const me = await music.account(); return me ? { ...me, page: 'my-channel' } : null; }
export function signOut() { cursors.clear(); music.signOut(); }
const cursors = new Map();
function cursor(key, offset) { return offset > 0 ? cursors.get(`${key}:${offset}`) : undefined; }
function keep(key, offset, token) {
  if (cursors.size > 256) cursors.delete(cursors.keys().next().value);
  if (token) cursors.set(`${key}:${offset}`, token);
  return Boolean(token);
}
const categories = [
  ['all', '全部', 'All', null], ['music', '音乐', 'Music', '10'], ['mixes', '合辑', 'Mixes', null],
  ['podcasts', '播客', 'Podcasts', null], ['gaming', '游戏', 'Gaming', '20'], ['live', '直播', 'Live', null],
  ['latest', '最近上传', 'Recently Uploaded', null], ['watched', '已观看（本机）', 'Watched on This Device', null], ['discover', '发现新视频', 'Discover', null],
];
const title = (cn, en) => host.language() === 'zh-CN' ? cn : en;
const publicTracks = (name, tracks, extra = {}) => ({ title: name, tracks, trackLayout: 'videos', ...extra });
async function homeFeed() {
  const answer = await webCall('browse', { browseId: 'FEwhat_to_watch' });
  const tracks = videos(answer);
  if (tracks.length) return { tracks, answer };
  // 新访客没有观看历史时 YouTube 首页为空，明确展示官方热门视频。
  if (hasOAuth()) { const popular = await api('videos', { part: 'snippet,contentDetails', chart: 'mostPopular', maxResults: 30 }); return { tracks: apiTracks(popular), answer: popular, kind: 'popular', guest: true }; }
  const result = await webCall('search', { query: title('热门视频', 'popular videos') });
  return { tracks: videos(result), answer: result, kind: 'search', guest: true };
}
async function nextHome(token) {
  if (token?.kind === 'popular') { const answer = await api('videos', { part: 'snippet,contentDetails', chart: 'mostPopular', maxResults: 30, pageToken: token.value }); return { tracks: apiTracks(answer), next: answer.nextPageToken ? { kind: 'popular', value: answer.nextPageToken } : undefined }; }
  if (token) { const answer = await webCall(token.kind === 'search' ? 'search' : 'browse', { continuation: token.value }); return { tracks: videos(answer), next: continuation(answer) ? { kind: token.kind, value: continuation(answer) } : undefined }; }
  const feed = await homeFeed(); const value = feed.kind === 'popular' ? feed.answer.nextPageToken : continuation(feed.answer);
  return { tracks: feed.tracks, next: value ? { kind: feed.kind || 'browse', value } : undefined };
}
export async function home() {
  const feed = await homeFeed();
  return { title: 'YouTube', sections: [
    { title: title('分类', 'Categories'), links: categories.map(([id, cn, en]) => ({ title: title(cn, en), page: `category:${id}` })) },
    publicTracks(feed.guest ? title('热门视频', 'Popular Videos') : title('推荐视频', 'Recommended Videos'), feed.tracks, { morePage: 'feed:home' }),
  ] };
}
function shortTrack(details, endpoint) {
  if (!details?.title || !videoId(details.videoId)) return null;
  const picture = endpoint?.thumbnail?.thumbnails?.at(-1);
  return { id: details.videoId, name: details.title, artists: [{ id: details.channelId || '', name: details.author || '' }],
    album: { id: '', name: '', imageUrl: picture?.url || details.thumbnail?.thumbnails?.at(-1)?.url }, duration: Number(details.lengthSeconds) * 1000,
    url: 'https://www.youtube.com/shorts/' + details.videoId, video: { width: picture?.width || 9, height: picture?.height || 16, short: true } };
}
async function shortsFeed(token) {
  if (!token) {
    const html = await webPage('/shorts/');
    const initial = embedded(html, 'var ytInitialData =');
    token = find(initial, 'sequenceContinuation')[0];
    if (!token) throw new Error(title('YouTube 暂未提供 Shorts 信息流', 'YouTube did not return a Shorts feed'));
  }
  const answer = await webCall('reel/reel_watch_sequence', { sequenceParams: token });
  const endpoints = (answer.entries || []).map(item => item.command?.reelWatchEndpoint).filter(item => videoId(item?.videoId));
  const tracks = [];
  for (let i = 0; i < endpoints.length; i += 3) {
    tracks.push(...await Promise.all(endpoints.slice(i, i + 3).map(async endpoint => {
      let details = endpoint.unserializedPrefetchData?.playerResponse?.videoDetails;
      if (!details) details = (await music.playerResponse(endpoint.videoId)).videoDetails;
      return shortTrack(details, endpoint);
    })));
  }
  return { tracks: tracks.filter(Boolean), next: answer.continuationEndpoint?.continuationCommand?.token };
}
export async function browse({ page, offset = 0 }) {
  if (page === 'watch-later') { const result = await playlist({ id: 'mb:watch-later', offset }); return { title: title('稍后观看 · MB', 'Watch Later · MB'), sections: [publicTracks(title('稍后观看 · MB', 'Watch Later · MB'), result.tracks)], more: result.more }; }
  const key = `browse:${page}`; const saved = cursor(key, offset);
  if (offset > 0 && !saved) return { sections: [], more: false };
  if (page === 'music') return music.home();
  if (['videos', 'videos:new', 'videos:charts', 'charts', 'new'].includes(page) || page.startsWith('video-chart:')) return music.browse({ page });
  let token = saved, base = page;
  if (page.startsWith('next:')) { const parsed = JSON.parse(decodeURIComponent(page.slice(5))); base = parsed.page; token = parsed.token; }
  let result, name = 'YouTube', endpoint = 'browse';
  if (base === 'shorts') { result = await shortsFeed(token); name = 'Shorts'; }
  else if (base === 'subscriptions') { result = await subscribedVideos(token); name = title('订阅', 'Subscriptions'); }
  else if (base === 'uploads') { result = await channelUploads(undefined, token); name = title('我的视频', 'My Videos'); }
  else if (base === 'recent' || base === 'category:watched') { result = { tracks: await recent() }; name = title('观看记录（本机）', 'History on This Device'); }
  else if (base === 'watch-later') { result = await playlist({ id: 'mb:watch-later', offset }); name = title('稍后观看 · MB', 'Watch Later · MB'); }
  else if (base === 'my-channel') {
    const me = await account();
    if (!me) throw Object.assign(new Error(title('请先登录 YouTube', 'Sign in to YouTube')), { code: 'signIn' });
    return { title: me.name, sections: [{ title: me.name, links: [{ title: title('我的视频', 'My Videos'), page: 'uploads' }, { title: title('订阅', 'Subscriptions'), page: 'subscriptions' }, { title: title('观看记录（本机）', 'History on This Device'), page: 'recent' }, { title: title('稍后观看 · MB', 'Watch Later · MB'), page: 'watch-later' }] }, { title: title('播放列表', 'Playlists'), playlists: await playlists() }] };
  } else if (base.startsWith('category:')) {
    const category = categories.find(item => item[0] === base.slice(9));
    if (!category) throw new Error('Unknown YouTube category');
    name = title(category[1], category[2]);
    if (category[0] === 'all') result = await nextHome(token);
    else if (hasOAuth() && (category[3] || ['latest', 'live', 'discover'].includes(category[0]))) {
      const popular = Boolean(category[3]);
      const answer = await api(popular ? 'videos' : 'search', { part: popular ? 'snippet,contentDetails' : 'snippet', maxResults: 50, pageToken: token,
        ...(popular ? { chart: 'mostPopular', videoCategoryId: category[3] } : { type: 'video', order: category[0] === 'latest' ? 'date' : 'relevance', ...(category[0] === 'live' ? { eventType: 'live' } : {}) }) });
      result = { tracks: apiTracks(answer), next: answer.nextPageToken };
    } else { const answer = await webCall('search', token ? { continuation: token } : { query: name }); result = { tracks: videos(answer), next: continuation(answer) }; }
  } else if (base === 'feed:home') result = await nextHome(token);
  else throw new Error('Unknown YouTube page');
  const sections = [publicTracks(name, result.tracks || [], { empty: title('暂无内容', 'No content') })];
  return { title: name, sections, more: keep(key, offset + (result.tracks?.length || 0), result.next) || result.more === true };
}
export async function search({ query, kind = 'tracks', offset = 0 }) {
  const pasted = /(?:youtu\.be\/|(?:watch\?.*?v=)|shorts\/)([\w-]{11})/.exec(query)?.[1];
  if (pasted) return music.searchVideos({ query: 'https://youtu.be/' + pasted, offset });
  if (!['tracks', 'videos', 'artists', 'playlists'].includes(kind)) return { [kind]: [], more: false };
  const key = `search:${kind}:${query}`; const token = cursor(key, offset);
  if (offset > 0 && !token) return { [kind === 'videos' ? 'tracks' : kind]: [], more: false };
  if (hasOAuth() && ['artists', 'playlists'].includes(kind)) {
    const answer = await api('search', { part: 'snippet', type: kind === 'artists' ? 'channel' : 'playlist', q: query, maxResults: 50, pageToken: token });
    const items = (answer.items || []).flatMap(item => {
      const id = kind === 'artists' ? item.id?.channelId : item.id?.playlistId;
      return id && item.snippet?.title ? [{ id, name: item.snippet.title, imageUrl: thumbnail(item.snippet) }] : [];
    });
    return { [kind]: items, more: keep(key, offset + items.length, answer.nextPageToken) };
  }
  const answer = await webCall('search', token ? { continuation: token } : { query });
  const items = kind === 'artists' ? find(answer, 'channelRenderer').map(row => ({ id: row.channelId, name: text(row.title), imageUrl: row.thumbnail?.thumbnails?.at(-1)?.url?.replace(/^\/\//, 'https://') })) : kind === 'playlists' ? find(answer, 'playlistRenderer').map(row => ({ id: row.playlistId, name: text(row.title), imageUrl: find(row, 'thumbnails')[0]?.at(-1)?.url })) : videos(answer);
  return { [kind === 'videos' ? 'tracks' : kind]: items, more: keep(key, offset + items.length, continuation(answer)) };
}
export const searchVideos = args => search({ ...args, kind: 'videos' });
export const suggest = args => music.suggest(args);
export async function lyrics({ id }) {
  const result = await captions(id);
  if (result.lines.length) return result;
  return music.lyrics({ id });
}
export async function comments({ trackId, offset = 0 }) {
  if (!videoId(trackId)) throw new Error('无效的 YouTube 视频 ID');
  const key = `comments:${trackId}`; const token = cursor(key, offset);
  if (offset > 0 && !token) return { comments: [], more: false };
  let result;
  if (token?.kind === 'web') { result = await webComments(trackId, token.value); result.kind = 'web'; }
  else if (hasOAuth()) { try { result = await officialComments(trackId, token?.value); } catch (error) { if (!['quotaExceeded', 'dailyLimitExceeded', 'insufficientPermissions'].includes(error.reason)) throw error; result = await webComments(trackId, token?.kind === 'web' ? token.value : undefined); result.kind = 'web'; } }
  else result = await webComments(trackId, token?.value);
  return { comments: result.comments, more: result.more && keep(key, offset + result.comments.length, { kind: result.kind || 'api', value: result.next }) };
}
export async function postComment({ trackId, text: content }) {
  const result = await api('commentThreads', { part: 'snippet' }, 'POST', { snippet: { videoId: trackId, topLevelComment: { snippet: { textOriginal: content } } } });
  const row = result.snippet.topLevelComment;
  return { id: row.id, text: row.snippet.textDisplay || row.snippet.textOriginal, author: row.snippet.authorDisplayName, avatarUrl: row.snippet.authorProfileImageUrl, likes: row.snippet.likeCount || 0 };
}
export async function isLiked({ ids }) {
  if (!hasOAuth()) return Object.fromEntries(ids.map(id => [id, false]));
  const answer = await api('videos/getRating', { id: ids.join(',') });
  return Object.fromEntries(ids.map(id => [id, answer.items?.find(item => item.videoId === id)?.rating === 'like']));
}
export const like = ({ id, on }) => api('videos/rate', { id, rating: on ? 'like' : 'none' }, 'POST');
export async function liked({ offset = 0 }) {
  const key = 'liked', token = cursor(key, offset);
  if (offset > 0 && !token) return { tracks: [], more: false };
  const answer = await api('videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50, pageToken: token });
  const tracks = apiTracks(answer); return { tracks, more: keep(key, offset + tracks.length, answer.nextPageToken) };
}
export async function playlists() {
  if (!hasOAuth()) return [];
  const items = []; let pageToken;
  do { const answer = await api('playlists', { part: 'snippet,contentDetails', mine: true, maxResults: 50, pageToken }); items.push(...(answer.items || [])); pageToken = answer.nextPageToken; } while (pageToken && items.length < 1000);
  return [{ id: 'mb:watch-later', name: title('稍后观看 · MB', 'Watch Later · MB'), mine: true, fixed: true }, ...items.map(item => ({ id: item.id, name: item.snippet.title, imageUrl: thumbnail(item.snippet), mine: true }))];
}
export async function playlist({ id, offset = 0 }) {
  const key = `playlist:${id}`, token = cursor(key, offset);
  if (offset > 0 && !token) return { tracks: [], more: false };
  if (id === 'mb:watch-later') { id = (await playlists()).find(item => item.name === 'MB 稍后观看')?.id; if (!id) return { tracks: [], more: false }; }
  const answer = await api('playlistItems', { part: 'snippet,contentDetails', playlistId: id, maxResults: 50, pageToken: token });
  const tracks = apiTracks(answer); return { tracks, more: keep(key, offset + tracks.length, answer.nextPageToken) };
}
export const album = args => music.album(args);
export async function artist({ id, offset = 0 }) {
  if (id.startsWith('UC')) {
    const key = `artist:${id}`, token = cursor(key, offset);
    if (offset > 0 && !token) return { tracks: [], more: false };
    if (hasOAuth()) { const result = await channelUploads(id, token); return { tracks: result.tracks, more: keep(key, offset + result.tracks.length, result.next) }; }
    const answer = await webCall('browse', token ? { continuation: token } : { browseId: id });
    const tracks = videos(answer); return { tracks, more: keep(key, offset + tracks.length, continuation(answer)) };
  }
  return music.artist({ id, offset });
}
export async function recent() { return (host.storage.get('youtubeHistory') || []).slice(0, 100); }
export async function played({ id }) {
  host.storage.set('lastPlayed', id);
  try {
    const result = await music.playerResponse(id); const d = result.videoDetails;
    if (!d?.title) return;
    const entry = { id, name: d.title, artists: [{ id: d.channelId || '', name: d.author || '' }], album: { id: '', name: '', imageUrl: d.thumbnail?.thumbnails?.at(-1)?.url }, duration: Number(d.lengthSeconds) * 1000, url: 'https://www.youtube.com/watch?v=' + id };
    host.storage.set('youtubeHistory', [entry, ...(host.storage.get('youtubeHistory') || []).filter(item => item.id !== id)].slice(0, 100));
  } catch (error) { console.warn('YouTube history: ' + error.message); }
}

export async function createPlaylist({ name }) {
  const item = await api('playlists', { part: 'snippet,status' }, 'POST', { snippet: { title: name }, status: { privacyStatus: 'private' } });
  return { id: item.id, name: item.snippet.title, mine: true };
}
export async function renamePlaylist({ id, name }) {
  const current = await api('playlists', { part: 'snippet', id });
  const snippet = current.items?.[0]?.snippet;
  if (!snippet) throw new Error(title('播放列表不存在或无权修改', 'Playlist is unavailable'));
  await api('playlists', { part: 'snippet' }, 'PUT', { id, snippet: { title: name, description: snippet.description || '', tags: snippet.tags, defaultLanguage: snippet.defaultLanguage } });
}
export const deletePlaylist = ({ id }) => api('playlists', { id }, 'DELETE');
export async function addToPlaylist({ id, trackIds }) {
  if (id === 'mb:watch-later') id = (await playlists()).find(item => item.name === 'MB 稍后观看')?.id || (await createPlaylist({ name: 'MB 稍后观看' })).id;
  for (const videoId of trackIds) await api('playlistItems', { part: 'snippet' }, 'POST', { snippet: { playlistId: id, resourceId: { kind: 'youtube#video', videoId } } });
}
export async function removeFromPlaylist({ id, trackIds }) {
  let pageToken;
  do { const answer = await api('playlistItems', { part: 'snippet', playlistId: id, maxResults: 50, pageToken });
    for (const item of answer.items || []) if (trackIds.includes(item.snippet.resourceId.videoId)) await api('playlistItems', { id: item.id }, 'DELETE');
    pageToken = answer.nextPageToken;
  } while (pageToken);
}
export async function followArtist({ id, on }) {
  if (on) await api('subscriptions', { part: 'snippet' }, 'POST', { snippet: { resourceId: { kind: 'youtube#channel', channelId: id } } });
  else { const answer = await api('subscriptions', { part: 'id', mine: true, forChannelId: id }); for (const item of answer.items || []) await api('subscriptions', { id: item.id }, 'DELETE'); }
}
