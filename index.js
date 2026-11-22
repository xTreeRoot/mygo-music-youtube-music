// MB YouTube 平台入口：完整视频、Shorts、分类和账号；音乐专区保留为独立入口。
import * as music from './music.js';
import * as feed from './youtube-feed.js';
import { hasOAuth } from './oauth.js';
import { api, apiTracks, officialComments, channelUploads, subscribedVideos, thumbnail } from './youtube-api.js';
import { webCall, webPage, videos, continuation, embedded, videoId, text, find, captions, webComments } from './youtube-web.js';
export { stream, video } from './music.js';
export async function signIn() { cursors.clear(); feed.resetFeeds(); try { return await music.signIn({ commentAccess: true }); } finally { feed.resetFeeds(); } }
export async function account() { const me = await music.account(); return me ? { ...me, page: 'my-channel' } : null; }
export function signOut() { cursors.clear(); feed.resetFeeds(); music.signOut(); }
const cursors = new Map();
function cursor(key, offset) { return offset > 0 ? cursors.get(`${key}:${offset}`) : undefined; }
function keep(key, offset, token) {
  if (cursors.size > 256) cursors.delete(cursors.keys().next().value);
  if (token) cursors.set(`${key}:${offset}`, token);
  return Boolean(token);
}
const title = (cn, en) => host.language() === 'zh-CN' ? cn : en;
const publicTracks = (name, tracks, extra = {}) => ({ title: name, tracks, trackLayout: 'videos', ...extra });
export const home = feed.home;
export async function browse({ page, offset = 0, refresh = false }) {
  if (page === 'discovery:music' || page === 'discovery:recommended') return feed.home({ sectionIds: [page.slice(10)] });
  if (page === 'shorts' || page === 'feed:home' || page === 'category:all' || page.startsWith('yt-feed:')) return feed.browse({ page, offset, refresh });
  if (page === 'watch-later') { const result = await playlist({ id: 'mb:watch-later', offset }); return { title: title('稍后观看 · MB', 'Watch Later · MB'), sections: [publicTracks(title('稍后观看 · MB', 'Watch Later · MB'), result.tracks)], more: result.more }; }
  const key = `browse:${page}`; const saved = cursor(key, offset);
  if (offset > 0 && !saved) return { sections: [], more: false };
  if (page === 'music') return music.home();
  if (['videos', 'videos:new', 'videos:charts', 'charts', 'new'].includes(page) || page.startsWith('video-chart:')) return music.browse({ page });
  let token = saved, base = page;
  if (page.startsWith('next:')) { const parsed = JSON.parse(decodeURIComponent(page.slice(5))); base = parsed.page; token = parsed.token; }
  let result, name = 'YouTube', endpoint = 'browse';
  if (base === 'subscriptions') { result = await subscribedVideos(token); name = title('订阅', 'Subscriptions'); }
  else if (base === 'uploads') { result = await channelUploads(undefined, token); name = title('我的视频', 'My Videos'); }
  else if (base === 'watch-later') { result = await playlist({ id: 'mb:watch-later', offset }); name = title('稍后观看 · MB', 'Watch Later · MB'); }
  else if (base === 'my-channel') {
    const me = await account();
    if (!me) throw Object.assign(new Error(title('请先登录 YouTube', 'Sign in to YouTube')), { code: 'signIn' });
    return { title: me.name, sections: [{ title: me.name, links: [{ title: title('我的视频', 'My Videos'), page: 'uploads' }, { title: title('订阅', 'Subscriptions'), page: 'subscriptions' }] }] };
  }  else throw new Error('Unknown YouTube page');
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
async function playlists() {
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
export async function followArtist({ id, on }) {
  if (on) await api('subscriptions', { part: 'snippet' }, 'POST', { snippet: { resourceId: { kind: 'youtube#channel', channelId: id } } });
  else { const answer = await api('subscriptions', { part: 'id', mine: true, forChannelId: id }); for (const item of answer.items || []) await api('subscriptions', { id: item.id }, 'DELETE'); }
}


/** 使用 Data API statistics 的公开总数；隐藏的计数保持未知。 */
export async function interactionSummary({ trackId }) {
  if (!videoId(trackId)) throw new Error('无效的 YouTube 视频 ID');
  if (!hasOAuth()) return {};
  const answer = await api('videos', { part: 'statistics', id: trackId, fields: 'items(statistics(likeCount,commentCount))' });
  const stats = answer.items?.[0]?.statistics;
  const result = {};
  for (const [key, raw] of [['likes', stats?.likeCount], ['comments', stats?.commentCount]]) {
    if ((typeof raw === 'string' && /^\d+$/.test(raw)) || typeof raw === 'number') {
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
    }
  }
  return result;
}
