import test from 'node:test';
import assert from 'node:assert/strict';
let sequence = 0;
async function setup(formats, status = { status: 'OK' }) {
  const requests = [];
  globalThis.host = { t: text => text, language: () => 'zh-CN', storage: { get: () => null } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => url.includes('visitor_id')
      ? { responseContext: { visitorData: 'synthetic-visitor' } }
      : { playabilityStatus: status, streamingData: { adaptiveFormats: formats } } };
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
