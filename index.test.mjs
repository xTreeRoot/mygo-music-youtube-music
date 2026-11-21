import test from 'node:test';
import assert from 'node:assert/strict';
let sequence = 0;
async function setup(formats, status = { status: 'OK' }, progressive = [], videoDetails) {
  const requests = [];
  globalThis.host = { t: text => text, language: () => 'zh-CN', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return { ok: true, status: 200, json: async () => url.includes('visitor_id')
      ? { responseContext: { visitorData: 'synthetic-visitor' } }
      : { playabilityStatus: status, streamingData: { adaptiveFormats: formats, formats: progressive }, videoDetails } };
  };
  return { plugin: await import(`./music.js?test=${++sequence}`), requests };
}
const aac = (bitrate, extra = {}) => ({ mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: `https://r1.googlevideo.com/videoplayback?synthetic=${bitrate}`, bitrate, ...extra });
test('native AAC selection replaces ffmpeg and reports the real bitrate', async () => {
  const { plugin, requests } = await setup([aac(64000), aac(128000), { mimeType: 'audio/webm; codecs="opus"', url: 'https://r1.googlevideo.com/opus', bitrate: 256000 }]);
  const high = await plugin.stream({ id: 'dQw4w9WgXcQ', quality: 'lossless' });
  assert.equal(high.type, 'm4a'); assert.equal(high.quality, 'high'); assert.equal(high.bitRate, 128000);
  assert.equal(high.headers.Cookie, undefined);
  assert.equal(requests[1].body.context.client.clientName, 'VISIONOS');
  const standard = await plugin.stream({ id: 'dQw4w9WgXcQ', quality: 'standard' });
  assert.equal(standard.bitRate, 64000); assert.equal(standard.quality, 'standard');
});

const avc = (height, extra = {}) => ({ mimeType: 'video/mp4; codecs="avc1.640028"', url: `https://r1.googlevideo.com/videoplayback?size=${height}&sig=a%20b%2Fz`, height, ...extra });

test('video and audio resolve concurrently without rewriting CDN signatures or using cookies', async () => {
  const low = avc(360), high = avc(720);
  const { plugin, requests } = await setup([aac(128000), high, avc(1080)], { status: 'OK' }, [low, avc(480, { url: 'https://wrong.googlevideo.com.evil.test/v' })]);
  const input = { id: 'dQw4w9WgXcQ' };
  const [audio, video] = await Promise.all([plugin.stream(input), plugin.video(input)]);
  assert.equal(audio.type, 'm4a');
  assert.equal(video.type, 'mp4');
  assert.equal(video.url, avc(1080).url);
  assert.equal(video.videoQuality, '1080p');
  assert.deepEqual(video.videoQualities.map(item => item.id), ['1080p', '720p', '360p']);
  assert.equal(requests.filter(request => request.url.includes('/player?')).length, 1);
  assert.ok(requests.every(request => !request.headers.cookie && !request.headers.authorization));
  assert.equal((await plugin.video({ ...input, quality: 'standard' })).url, low.url);
});

test('video quality selection uses real formats, preserves portrait resolution and falls back honestly', async () => {
  const portrait = avc(1920, { width: 1080, fps: 60 });
  const lower = avc(1280, { width: 720 });
  const duplicate = avc(1920, { width: 1080, fps: 30 });
  const { plugin } = await setup([portrait, lower, duplicate]);
  const input = { id: 'dQw4w9WgXcQ' };
  const automatic = await plugin.video(input);
  assert.equal(automatic.url, portrait.url);
  assert.deepEqual(automatic.videoQualities, [{ id: '1080p', label: '1080p60' }, { id: '720p', label: '720p' }]);
  assert.equal((await plugin.video({ ...input, quality: '720p' })).url, lower.url);
  assert.equal((await plugin.video({ ...input, quality: '1440p' })).videoQuality, '1080p');
  assert.equal((await plugin.video({ ...input, quality: '360p' })).videoQuality, '720p');
});

test('an audio-only response never pretends to be a video stream', async () => {
  const { plugin } = await setup([aac(128000), avc(720, { mimeType: 'video/webm; codecs="vp9"' }), avc(360, { url: 'https://user@r1.googlevideo.com/a' }), avc(480, { url: undefined, signatureCipher: 'fixture' })]);
  await assert.rejects(plugin.video({ id: 'dQw4w9WgXcQ' }), { code: 'unavailable' });
  assert.equal((await plugin.stream({ id: 'dQw4w9WgXcQ' })).type, 'm4a');
});

test('pasted YouTube links use the original video metadata and reject audio-only or live videos', async () => {
  const details = { title: 'Fixture video', author: 'Uploader', lengthSeconds: '83', shortDescription: 'Actual description',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/picture', width: 640, height: 360 }] } };
  const { plugin, requests } = await setup([aac(128000), avc(360)], undefined, [], details);
  const direct = await plugin.searchVideos({ query: 'https://www.youtube.com/watch?si=share&v=dQw4w9WgXcQ' });
  assert.deepEqual(direct.tracks.map(track => [track.name, track.artists[0].name, track.duration, track.description]), [['Fixture video', 'Uploader', 83000, 'Actual description']]);
  const compact = { query: 'https://youtu.be/dQw4w9WgXcQ?si=share' };
  assert.deepEqual(await plugin.search(compact), direct);
  assert.deepEqual(await plugin.search({ ...compact, offset: 1 }), { tracks: [], more: false });
  assert.ok(requests.every(request => !request.url.includes('/search?')));
  for (const [formats, videoDetails] of [[[aac(128000)], details], [[aac(128000), avc(360)], { ...details, isLiveContent: true }]]) {
    const { plugin } = await setup(formats, undefined, [], videoDetails);
    await assert.rejects(plugin.searchVideos(compact), { code: 'unavailable' });
  }
});

const sampleRow = (videoId, name, type) => ({ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } } } } } } },
    flexColumns: [name, 'Artist', '3:08'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [
      { url: 'https://i.ytimg.com/wide=w640-h360', width: 640, height: 360 },
      { url: 'https://i.ytimg.com/square=w544-h544', width: 544, height: 544 },
    ] } } },
} });

test('video browsing keeps wide artwork and search resumes its own video filter', async () => {
  const requests = [];
  const music = sampleRow('00000000001', 'Audio', 'MUSIC_VIDEO_TYPE_ATV');
  const movie = sampleRow('00000000002', 'Actual MV', 'MUSIC_VIDEO_TYPE_OMV');
  const next = sampleRow('00000000003', 'Next video', 'MUSIC_VIDEO_TYPE_UGC');
  globalThis.host = { t: text => text, language: () => 'en', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    let answer;
    if (url.includes('/browse?')) answer = { sectionListRenderer: { contents: [{ musicCarouselShelfRenderer: { title: { runs: [{ text: 'Real shelf' }] }, contents: [music, movie] } }] } };
    else if (body.continuation) answer = { musicShelfContinuation: { contents: [next] } };
    else answer = { musicShelfRenderer: { contents: [music, movie], continuations: [{ nextContinuationData: { continuation: 'fixture' } }] } };
    return { ok: true, json: async () => answer };
  };
  const plugin = await import(`./music.js?test=${++sequence}`);
  const [section] = (await plugin.browse({ page: 'videos' })).sections;
  assert.equal(section.trackLayout, 'videos');
  assert.deepEqual(section.tracks.map(track => [track.id, track.name, track.artists[0].name, track.duration]), [['00000000002', 'Actual MV', 'Artist', 188000]]);
  assert.equal(section.tracks[0].album.imageUrl, 'https://i.ytimg.com/wide=w640-h360');
  assert.equal(section.tracks[0].url, 'https://www.youtube.com/watch?v=00000000002');
  assert.ok(requests.some(body => body.browseId === 'FEmusic_new_releases'));
  const results = await plugin.searchVideos({ query: 'fixture' });
  assert.deepEqual(results.tracks.map(track => track.name), ['Actual MV']);
  assert.equal(results.more, true);
  assert.equal(requests.find(body => body.query === 'fixture').params, 'EgWKAQIQAWoMEA4QChADEAQQCRAF');
  assert.equal((await plugin.search({ query: 'fixture', kind: 'videos', offset: 1 })).tracks[0].id, '00000000003');
  assert.equal(requests.at(-1).continuation, 'fixture');
});

test('the video hub opens the full gallery and playable regional charts, not the music charts', async () => {
  const requests = [];
  const clips = Array.from({ length: 10 }, (_, position) => sampleRow(String(position).padStart(11, '0'), `Clip ${position}`, 'MUSIC_VIDEO_TYPE_OMV'));
  const chartId = 'PL_RegionalFixture';
  const collection = (id, title) => ({ musicTwoRowItemRenderer: {
    title: { simpleText: title }, navigationEndpoint: { browseEndpoint: { browseId: `VL${id}`,
      browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' } } } },
  } });
  const shelf = (title, contents) => ({ musicCarouselShelfRenderer: { title: { simpleText: title }, contents } });
  const sections = (...contents) => ({ sectionListRenderer: { contents } });
  globalThis.host = { t: value => value, language: () => 'zh-CN', storage: { get: () => null } };
  globalThis.fetch = async (_, options) => {
    const { browseId } = JSON.parse(options.body);
    requests.push(browseId);
    const answers = {
      FEmusic_new_releases: sections(shelf('Music videos', clips)),
      FEmusic_new_releases_videos: sections({ gridRenderer: { items: [...clips, clips[0]] } }),
      FEmusic_charts: sections(shelf('流派', [collection('PL_NotAVideoChart', 'Not a video chart')]), shelf('视频排行榜', [collection(chartId, 'Actual regional chart')])),
      [`VL${chartId}`]: { musicPlaylistShelfRenderer: { contents: [sampleRow('00000000020', 'Audio', 'MUSIC_VIDEO_TYPE_ATV'), sampleRow('00000000021', 'Live performance', 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC')] } },
    };
    assert.ok(answers[browseId], browseId);
    return { ok: true, json: async () => answers[browseId] };
  };
  const plugin = await import(`./music.js?test=${++sequence}`);
  const home = await plugin.browse({ page: 'videos' });
  assert.equal(home.sections[0].tracks.length, 6);
  assert.deepEqual(requests, ['FEmusic_new_releases', 'FEmusic_charts']);
  const gallery = await plugin.browse({ page: home.sections[0].morePage });
  assert.deepEqual(gallery.sections[0].tracks.map(track => track.name), clips.map((_, position) => `Clip ${position}`));
  const links = home.sections.flatMap(section => section.links || []);
  assert.deepEqual(links.map(link => link.title), ['Actual regional chart']);
  const chart = await plugin.browse({ page: links[0].page });
  assert.deepEqual(chart.sections[0].tracks.map(track => track.name), ['Live performance']);
  assert.equal(chart.sections[0].trackLayout, 'videos');
});

test('public comments use only the matching top-level continuation and preserve returned order', async () => {
  const trackId = 'dQw4w9WgXcQ';
  const initial = { tabRenderer: { title: '评论', content: { sectionListRenderer: { continuations: [{ reloadContinuationData: { continuation: 'page1' } }] } } } };
  const continuation = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  const thread = commentKey => ({ commentThreadRenderer: { commentViewModel: { commentViewModel: { commentKey } }, replies: continuation('reply-not-page') } });
  const comment = (key, text, count) => ({ payload: { commentEntityPayload: { key, properties: { commentId: key, content: { content: text } }, author: { displayName: 'Viewer', avatarThumbnailUrl: 'https://yt3.ggpht.com/avatar' }, toolbar: { likeCountNotliked: count } } } });
  const page = (action, continuationItems, mutations) => ({
    onResponseReceivedEndpoints: [{ [action]: { targetId: 'ignored', continuationItems: [thread('reply'), continuation('wrong-target')] } }, { [action]: { targetId: trackId, continuationItems } }],
    frameworkUpdates: { entityBatchUpdate: { mutations } },
  });
  const replies = comment('reply', 'Auxiliary entity', '10');
  const first = page('reloadContinuationItemsCommand', [{ commentsHeaderRenderer: { commentsCount: { runs: [{ text: '2.1K' }] }, countText: { runs: [{ text: '2,100 条评论' }] } } }, thread('comment-1'), thread('comment-2'), continuation('page2')],
    [comment('comment-2', 'Second', '1.2K'), replies, comment('comment-1', 'First', '312')]);
  const second = page('appendContinuationItemsAction', [thread('comment-3')], [comment('comment-3', 'Third', '2')]);
  const requested = [];
  globalThis.host = { t: value => value, language: () => 'zh-CN', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    assert.ok(url.includes('/next?'));
    const body = JSON.parse(options.body);
    requested.push(body.continuation || body.videoId);
    const answer = { [trackId]: initial, page1: first, page2: second }[requested.at(-1)];
    return { ok: true, json: async () => answer || {} };
  };
  const plugin = await import(`./music.js?test=${++sequence}`);
  const head = await plugin.comments({ trackId });
  assert.deepEqual(head.comments.map(item => [item.text, item.likes]), [['First', 312], ['Second', undefined]]);
  assert.equal(head.total, 2100);
  assert.equal(head.more, true);
  const tail = await plugin.comments({ trackId, offset: head.comments.length });
  assert.deepEqual(tail.comments.map(item => item.text), ['Third']);
  assert.equal(tail.more, false);
  assert.equal(tail.total, 2100);
  assert.deepEqual(await plugin.comments({ trackId: '00000000000', offset: 2 }), { comments: [], more: false });
  assert.deepEqual(requested, [trackId, 'page1', 'page2']);
  assert.equal(plugin.postComment, undefined);
});

test('concurrent resolution shares a request but playback can renew an expired URL', async () => {
  const formats = [aac(128000)];
  const { plugin, requests } = await setup(formats);
  const input = { id: 'dQw4w9WgXcQ' };
  const [first, shared] = await Promise.all([plugin.stream(input), plugin.stream(input)]);
  assert.deepEqual(first, shared);
  assert.equal(requests.filter(request => request.url.includes('/player?')).length, 1);
  formats[0] = aac(128000, { url: `${first.url}&renewed=1` });
  assert.equal((await plugin.stream(input)).url, formats[0].url);
  assert.equal(requests.filter(request => request.url.includes('/player?')).length, 2);
});
test('missing AAC, third-party URLs and unplayable content fail without desktop fallback', async () => {
  for (const [formats, status] of [
    [[{ mimeType: 'audio/webm', url: 'https://r1.googlevideo.com/opus' }], { status: 'OK' }],
    [[aac(128000, { url: 'https://example.test/audio' })], { status: 'OK' }],
    [[aac(128000)], { status: 'LOGIN_REQUIRED', reason: '需要登录' }],
    [[aac(128000, { isDrc: true })], { status: 'OK' }],
  ]) {
    const { plugin } = await setup(formats, status);
    await assert.rejects(plugin.stream({ id: 'dQw4w9WgXcQ' }), { code: 'unavailable' });
  }
});
