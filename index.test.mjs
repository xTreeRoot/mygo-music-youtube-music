import test from 'node:test';
import assert from 'node:assert/strict';
let sequence = 0;
async function setup(formats, status = { status: 'OK' }, progressive = []) {
  const requests = [];
  globalThis.host = { t: text => text, language: () => 'zh-CN', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return { ok: true, status: 200, json: async () => url.includes('visitor_id')
      ? { responseContext: { visitorData: 'synthetic-visitor' } }
      : { playabilityStatus: status, streamingData: { adaptiveFormats: formats, formats: progressive } } };
  };
  return { plugin: await import(`./index.js?test=${++sequence}`), requests };
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
  assert.equal(video.url, high.url);
  assert.equal(requests.filter(request => request.url.includes('/player?')).length, 1);
  assert.ok(requests.every(request => !request.headers.cookie && !request.headers.authorization));
  assert.equal((await plugin.video({ ...input, quality: 'standard' })).url, low.url);
});

test('an audio-only response never pretends to be a video stream', async () => {
  const { plugin } = await setup([aac(128000), avc(720, { mimeType: 'video/webm; codecs="vp9"' }), avc(360, { url: 'https://user@r1.googlevideo.com/a' }), avc(480, { url: undefined, signatureCipher: 'fixture' })]);
  await assert.rejects(plugin.video({ id: 'dQw4w9WgXcQ' }), { code: 'unavailable' });
  assert.equal((await plugin.stream({ id: 'dQw4w9WgXcQ' })).type, 'm4a');
});

test('video browsing keeps real MV metadata and search resumes its own video filter', async () => {
  const requests = [];
  const row = (videoId, name, type) => ({ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } } } } } } },
    flexColumns: [name, 'Artist', '3:08'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/fixture.jpg' }] } } },
  } });
  const music = row('00000000001', 'Audio', 'MUSIC_VIDEO_TYPE_ATV');
  const movie = row('00000000002', 'Actual MV', 'MUSIC_VIDEO_TYPE_OMV');
  const next = row('00000000003', 'Next video', 'MUSIC_VIDEO_TYPE_UGC');
  globalThis.host = { t: text => text, language: () => 'en', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    let answer;
    if (url.includes('/browse?')) answer = { sectionListRenderer: { contents: [{ musicCarouselShelfRenderer: { title: { runs: [{ text: 'Real shelf' }] }, contents: [music, movie] } }] } };
    else if (body.continuation) answer = { musicShelfContinuation: { contents: [next] } };
    else answer = { musicShelfRenderer: { contents: [movie], continuations: [{ nextContinuationData: { continuation: 'fixture' } }] } };
    return { ok: true, json: async () => answer };
  };
  const plugin = await import(`./index.js?test=${++sequence}`);
  const [section] = (await plugin.browse({ page: 'videos' })).sections;
  assert.equal(section.title, 'Real shelf');
  assert.equal(section.trackLayout, 'videos');
  assert.deepEqual(section.tracks.map(track => [track.id, track.name, track.artists[0].name, track.duration]), [['00000000002', 'Actual MV', 'Artist', 188000]]);
  assert.equal(requests[0].browseId, 'FEmusic_new_releases');
  const results = await plugin.searchVideos({ query: 'fixture' });
  assert.equal(results.tracks[0].name, 'Actual MV');
  assert.equal(results.more, true);
  assert.equal(requests[1].params, 'EgWKAQIQAWoMEA4QChADEAQQCRAF');
  assert.equal((await plugin.search({ query: 'fixture', kind: 'videos', offset: 1 })).tracks[0].id, '00000000003');
  assert.equal(requests[2].continuation, 'fixture');
});
test('concurrent resolution shares a request and caches only successful audio', async () => {
  const { plugin, requests } = await setup([aac(128000)]);
  const values = await Promise.all([plugin.stream({ id: 'dQw4w9WgXcQ' }), plugin.stream({ id: 'dQw4w9WgXcQ' })]);
  assert.deepEqual(values[0], values[1]);
  assert.equal(requests.filter(x => x.url.includes('/player?')).length, 1);
  await plugin.stream({ id: 'dQw4w9WgXcQ' });
  assert.equal(requests.filter(x => x.url.includes('/player?')).length, 1);
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
