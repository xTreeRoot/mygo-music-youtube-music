// YouTube Data API 公开合同：原生 OAuth 账号、收藏、订阅与评论，不向网页接口发送 Bearer。
import { oauthHeaders, hasOAuth } from './oauth.js';
import { videoId } from './youtube-web.js';
const root = 'https://youtube.googleapis.com/youtube/v3/';
export async function api(resource, parameters = {}, method = 'GET', body) {
  if (!hasOAuth()) { const error = new Error('请先登录 YouTube'); error.code = 'signIn'; throw error; }
  if (resource === 'videos' && method === 'GET' && !parameters.fields) parameters = { ...parameters, fields: 'items(id,snippet(title,channelId,channelTitle,thumbnails,publishedAt),contentDetails(duration)),nextPageToken' };
  const query = new URLSearchParams(Object.fromEntries(Object.entries(parameters).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])));
  const res = await fetch(root + resource + '?' + query, { method, headers: { ...await oauthHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 204) return {};
  const value = await res.json();
  if (!res.ok) {
    const reason = value.error?.errors?.[0]?.reason;
    const message = reason === 'insufficientPermissions' ? '当前授权缺少此操作权限，请重新登录 YouTube 并允许请求的权限' : reason === 'commentsDisabled' ? '此视频已关闭评论' : `YouTube ${resource}: HTTP ${res.status}${reason ? ` (${reason})` : ''}`;
    const error = new Error(message); error.status = res.status; error.reason = reason; throw error;
  }
  return value;
}
const thumbnail = snippet => snippet?.thumbnails?.maxres?.url || snippet?.thumbnails?.high?.url || snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url;
const milliseconds = value => {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || '');
  return match ? ((Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0)) * 1000 : 0;
};
export function apiTrack(value) {
  const id = value.contentDetails?.videoId || value.snippet?.resourceId?.videoId || value.id?.videoId || value.id;
  if (!videoId(id) || !value.snippet?.title || ['Private video', 'Deleted video'].includes(value.snippet.title)) return null;
  const s = value.snippet;
  return { id, name: s.title, artists: [{ id: s.videoOwnerChannelId || s.channelId || '', name: s.videoOwnerChannelTitle || s.channelTitle || '' }],
    album: { id: '', name: '', imageUrl: thumbnail(s) }, duration: milliseconds(value.contentDetails?.duration), publishedAt: s.videoPublishedAt || s.publishedAt, url: `https://www.youtube.com/watch?v=${id}` };
}
export const apiTracks = value => (value.items || []).map(apiTrack).filter(Boolean);
export async function officialComments(trackId, pageToken) {
  try {
    const answer = await api('commentThreads', { part: 'snippet', videoId: trackId, maxResults: 50, order: 'relevance', textFormat: 'plainText', pageToken });
    return { comments: (answer.items || []).map(item => {
      const row = item.snippet.topLevelComment;
      const s = row.snippet;
      return { id: row.id, text: s.textDisplay || s.textOriginal, author: s.authorDisplayName, avatarUrl: s.authorProfileImageUrl, likes: s.likeCount, time: Date.parse(s.publishedAt) || 0 };
    }), next: answer.nextPageToken, more: Boolean(answer.nextPageToken) };
  } catch (error) { if (error.reason === 'commentsDisabled') return { comments: [], more: false }; throw error; }
}
export async function channelUploads(channelId, pageToken) {
  const channel = await api('channels', { part: 'contentDetails,snippet', ...(channelId ? { id: channelId } : { mine: true }) });
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { tracks: [], more: false };
  const answer = await api('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 50, pageToken });
  return { tracks: apiTracks(answer), next: answer.nextPageToken, more: Boolean(answer.nextPageToken) };
}
export async function subscribedVideos(pageToken) {
  const subscriptions = await api('subscriptions', { part: 'snippet', mine: true, maxResults: 20, order: 'unread', pageToken });
  const channels = [];
  const ids = (subscriptions.items || []).map(item => item.snippet.resourceId.channelId);
  for (let i = 0; i < ids.length; i += 3) channels.push(...await Promise.all(ids.slice(i, i + 3).map(id => channelUploads(id))));
  return { tracks: channels.flatMap(item => item.tracks.slice(0, 3)).sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index), next: subscriptions.nextPageToken, more: Boolean(subscriptions.nextPageToken) };
}
export { thumbnail };
