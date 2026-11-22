import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticVideo, playerCache } from './media-policy.js';
const formats = [2160, 1080, 720, 480, 360].map(height => ({ height, bitrate: height * 2000 }));
const resolution = item => item.height;
test('automatic selection uses measured bandwidth and congestion; unknown networks start at 720p', () => {
  assert.equal(automaticVideo(formats, {}, resolution).height, 720);
  assert.equal(automaticVideo(formats, { bandwidthBps: 4000000 }, resolution).height, 1080);
  assert.equal(automaticVideo(formats, { bandwidthBps: 1200000 }, resolution).height, 360);
  assert.equal(automaticVideo(formats, { bandwidthBps: 50000000, constrained: true }, resolution).height, 480);
  assert.equal(automaticVideo(formats, { bandwidthBps: 50000000, recentStall: true }, resolution).height, 480);
  assert.equal(automaticVideo(formats, { bandwidthBps: NaN }, resolution).height, 720);
});
test('short player cache shares concurrent and adjacent requests, expires and bounds entries', async () => {
  let clock = 0, calls = 0;
  const cached = playerCache({ now: () => clock, capacity: 2, lifetime: 30 });
  const load = async () => ({ playabilityStatus: { status: 'OK' }, count: ++calls });
  assert.equal((await Promise.all([cached('a', load), cached('a', load)]))[0].count, 1);
  assert.equal((await cached('a', load, 'video')).count, 1);
  clock = 31;
  assert.equal((await cached('a', load)).count, 2);
  await cached('b', load); await cached('c', load);
  assert.equal((await cached('a', load)).count, 5);
  await assert.rejects(cached('fail', async () => { throw Error('network'); }));
  assert.equal((await cached('fail', load)).count, 6);
  await cached('blocked', async () => ({ playabilityStatus: { status: 'ERROR' } }));
  assert.equal((await cached('blocked', load)).count, 7);
});
