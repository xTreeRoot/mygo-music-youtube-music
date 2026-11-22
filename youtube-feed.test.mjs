import test from 'node:test';
import assert from 'node:assert/strict';
const data = new Map();
globalThis.host = { language: () => 'zh-CN', t: x => x, platform: 'android', storage: { get: k => data.get(k), set: (k,v) => data.set(k,v) } };
const feed = await import('./youtube-feed.js');
const web = await import('./youtube-web.js');
const reply = (value, status = 200) => ({ ok: status === 200, status, json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const tracking = { responseContext: { visitorData: 'visitor-fixture', serviceTrackingParams: [{ params: [{ key: 'logged_in', value: '1' }] }] } };
const next = continuation => continuation ? { continuations: [{ nextContinuationData: { continuation } }] } : {};
const tile = (id, short = false) => ({ tileRenderer: {
  contentType: short ? 'TILE_CONTENT_TYPE_SHORTS' : 'TILE_CONTENT_TYPE_VIDEO',
  onSelectCommand: { [short ? 'reelWatchEndpoint' : 'watchEndpoint']: { videoId: id, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/portrait', width: 1080, height: 1920 }] } } },
  metadata: { tileMetadataRenderer: { title: { simpleText: 'Video ' + id }, lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: 'Creator' } } }] } }] } },
  header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/wide' }] } } }
} });
const shelf = (title, tracks, continuation, short = false) => ({ shelfRenderer: { title: { simpleText: title },
  ...(short ? { tvhtml5ShelfRendererType: 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS' } : {}),
  content: { horizontalListRenderer: { items: tracks, ...next(continuation) } } } });
const page = (shelves, continuation) => ({ ...tracking, contents: { sectionListRenderer: { contents: shelves, ...next(continuation) } } });
const guide = { ...tracking, items: [{ guideEntryRenderer: { formattedTitle: { simpleText: 'Home' }, navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
  ...['music', 'movies', 'gaming', 'news', 'podcasts'].map(kind => ({ guideEntryRenderer: { formattedTitle: { simpleText: kind }, navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_' + kind } } } }))] };
function session() { data.clear(); data.set('oauthSession', { active: true, access: 'fixture-token', expires: Date.now() + 3_600_000 }); feed.resetFeeds(); }
const id = '00000000001', other = '00000000002', third = '00000000003';

test('signed-in home forwards native authorization only through TV feed and preserves real shelves and topic routes', async () => {
  session(); const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    assert.equal(options.headers['x-youtube-client-name'], '7');
    const body = JSON.parse(options.body); assert.equal(body.context.client.clientName, 'TVHTML5'); requests.push(body);
    if (url.includes('/guide?')) return reply(guide);
    return reply(body.continuation === 'home-next' ? page([shelf('推荐的音乐视频', [tile(third)], 'music-next'), shelf('其他栏目', [tile(id)])]) : page([shelf('为你推荐', [tile(id)], 'shelf-next'), shelf('Shorts', [tile(other, true)], 'short-next', true)], 'home-next'));
  };
  const home = await feed.home();
  assert.deepEqual(home.sections.map(s => s.tracks[0]?.id), [third, other, id]);
  assert.equal(home.sections[0].morePage.startsWith('yt-feed:'), true);
  assert.equal(JSON.parse(decodeURIComponent(home.sections[0].morePage.slice(8))).request.continuation, 'music-next');
  assert.equal(JSON.parse(decodeURIComponent(home.sections[2].morePage.slice(8))).request.continuation, 'shelf-next');
  assert.deepEqual(home.tabs.map(t => t.title), ['全部', '音乐', '播客', '游戏']);
  assert.equal(JSON.parse(decodeURIComponent(home.tabs[1].page.slice(8))).request.browseId, 'FEtopics_music');
  assert.equal(home.sections[1].tracks[0].video.height, 1920);
  assert.equal(home.sections[1].tracks[0].album.imageUrl, 'https://i.ytimg.com/portrait');
  assert.equal(requests[0].browseId, 'FEwhat_to_watch');
});

test('topic vertical continuation survive module reload while stale cursor is discarded after refresh', async () => {
  session(); const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body); requests.push(body);
    return reply(body.continuation ? { ...tracking, continuationContents: { sectionListContinuation: { contents: [shelf('第二页', [tile(other)])] } } } : page([shelf('推荐视频', [tile(id)])], 'next-home'));
  };
  const route = 'yt-feed:' + encodeURIComponent(JSON.stringify({ request: { browseId: 'FEtopics_music' }, title: 'Music' }));
  assert.equal((await feed.browse({ page: route })).more, true);
  const restored = await import('./youtube-feed.js?restart=1');
  const second = await restored.browse({ page: route, offset: 1 });
  assert.equal(second.sections[0].tracks[0].id, other); assert.equal(second.more, false);
  assert.equal(requests.at(-1).continuation, 'next-home');
  data.set('youtube.feed.pages.v1', { [route + ':99']: { token: 'stale' } });
  await feed.browse({ page: route });
  assert.equal(data.get('youtube.feed.pages.v1')[route + ':99'], undefined);
});

test('Shorts use authenticated shelf order, real continuation and deduplicate overlapping videos', async () => {
  session(); let continuation;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body);
    if (body.continuation) { continuation = body.continuation; return reply({ ...tracking, continuationContents: { horizontalListContinuation: { items: [tile(id, true), tile(third, true)] } } }); }
    return reply(page([shelf('Shorts', [tile(other, true), tile(id, true)], 'short-next', true)]));
  };
  const first = await feed.browse({ page: 'shorts' }); assert.deepEqual(first.sections[0].tracks.map(t => t.id), [other, id]);
  assert.equal(first.more, true);
  const second = await feed.browse({ page: 'shorts', offset: 2 }); assert.deepEqual(second.sections[0].tracks.map(t => t.id), [third]);
  assert.equal(continuation, 'short-next'); assert.equal(second.more, false);
});

test('modern WEB locks and TV tiles skip advertisements, playlists and duplicates', () => {
  const result = web.videos({ contents: [tile(id), tile(id), { adSlotRenderer: tile(other) },
    { tileRenderer: { ...tile(third).tileRenderer, contentType: 'TILE_CONTENT_TYPE_PLAYLIST' } },
    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: other, metadata: { lockupMetadataViewModel: { title: { content: 'Modern title' } } } } }] });
  assert.deepEqual(result.map(t => t.id), [id, other]); assert.equal(result[1].name, 'Modern title');
});

test('empty personalized home stays empty and never uses popular chart or search as substitute', async () => {
  session(); globalThis.fetch = async url => { assert.ok(url.includes('/browse?') || url.includes('/guide?')); return reply(url.includes('/guide?') ? guide : { ...tracking, contents: {} }); };
  const home = await feed.home(); assert.equal(home.sections[0].tracks.length, 0); assert.match(home.sections[0].empty, /暂未返回推荐/);
});

test('account reset rejects late recommendation and does not restore old visitors or pagination', async () => {
  session(); let complete, started;
  const pending = new Promise(r => { started = r; });
  globalThis.fetch = async () => { started(); return new Promise(r => { complete = r; }); };
  const request = feed.browse({ page: 'feed:home' }); await pending;
  feed.resetFeeds(); complete(reply(page([shelf('Old account', [tile(id)])], 'old-token')));
  await assert.rejects(request, /登录状态已改变/);
  assert.deepEqual(data.get('youtube.feed.pages.v1'), {});
});

test('server rejecting account is an explicit sign-in error rather than anonymous fallback', async () => {
  session(); globalThis.fetch = async () => reply({ responseContext: { serviceTrackingParams: [{ params: [{ key: 'logged_in', value: '0' }] }] } });
  await assert.rejects(feed.home(), error => error.code === 'signIn');
});

test('temporary category failure preserves loaded recommendations and retries categories on refresh', async () => {
  session(); let guideRequests = 0;
  globalThis.fetch = async url => {
    if (url.includes('/guide?')) return ++guideRequests === 1 ? reply({}, 503) : reply(guide);
    return reply(page([shelf('推荐视频', [tile(id)])]));
  };
  const first = await feed.home();
  assert.equal(first.sections[2].tracks[0].id, id); assert.deepEqual(first.tabs, []);
  const second = await feed.home();
  assert.deepEqual(second.tabs.map(item => item.title), ['全部', '音乐', '播客', '游戏']);
});

test('invalid routes cannot inject arbitrary browse endpoint or more than one parameter', async () => {
  session(); globalThis.fetch = async () => { throw new Error('must not request'); };
  for (const request of [{ browseId: 'arbitrary' }, { browseId: 'FEtopics_music', continuation: 'x' }, { continuation: 42 }]) {
    await assert.rejects(feed.browse({ page: 'yt-feed:' + encodeURIComponent(JSON.stringify({ request, title: 'x' })) }), /无效/);
  }
});

test('All to Music to All and refresh rebuild the complete homepage with independent shelf cursors', async () => {
  session(); let homes = 0; const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body); requests.push(body);
    if (body.browseId === 'FEwhat_to_watch') { homes++; return reply(page([shelf('推荐视频', [tile(id)], 'videos-' + homes)], 'tail-' + homes)); }
    if (body.browseId === 'FEtopics_music') return reply(page([shelf('最近播放的音乐', [tile(id)])]));
    if (body.continuation?.startsWith('tail-')) return reply(page([
      shelf('推荐的音乐视频', [tile(third)], 'music-' + homes), shelf('Shorts', [tile(other, true)], 'short-' + homes, true),
      shelf('其他栏目', [tile(id)])]));
    if (body.continuation === 'short-3') return reply({ ...tracking, continuationContents: { horizontalListContinuation: { items: [tile(third, true)] } } });
    throw new Error('Unexpected request');
  };
  const initial = await feed.home();
  const music = await feed.browse({ page: initial.tabs[1].page });
  assert.equal(music.sections[0].tracks[0].id, id);
  let restored;
  for (const route of ['feed:home', 'category:all']) {
    restored = await feed.browse({ page: route });
    assert.deepEqual(restored.sections.map(s => s.tracks.map(t => t.id)), [[third], [other], [id]]);
    assert.equal(restored.selectedTab, initial.selectedTab);
    assert.equal(restored.more, false);
    assert.equal(JSON.parse(decodeURIComponent(restored.sections[1].morePage.slice(8))).request.continuation, 'short-' + homes);
  }
  const shorts = await feed.browse({ page: restored.sections[1].morePage });
  assert.equal(shorts.sections[0].tracks[0].id, other);
  assert.equal((await feed.browse({ page: restored.sections[1].morePage, offset: 1 })).sections[0].tracks[0].id, third);
  const refreshed = await feed.home();
  assert.equal(homes, 4);
  assert.deepEqual(refreshed.sections.map(s => s.tracks.map(t => t.id)), [[third], [other], [id]]);
  assert.equal(requests.filter(body => body.browseId === 'FEwhat_to_watch').length, 4);
});

test('missing music recommendations use only the server-declared music category and keep shelf pagination', async () => {
  session(); const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body); requests.push(body);
    if (body.browseId === 'FEwhat_to_watch') return reply(page([shelf('推荐视频', [tile(id)]), shelf('Shorts', [tile(other, true)], undefined, true)]));
    if (body.browseId === 'FEtopics_music') return reply(page([shelf('老歌重温', [tile(id)]), shelf('推荐的音乐视频', [tile(third)], 'music-more')]));
    assert.equal(body.continuation, 'music-more');
    return reply({ ...tracking, continuationContents: { horizontalListContinuation: { items: [tile(other)] } } });
  };
  const home = await feed.home();
  const more = await feed.browse({ page: home.sections[0].morePage });
  assert.deepEqual(home.sections.map(s => s.tracks[0]?.id), [third, other, id]);
  assert.equal(more.sections[0].tracks[0].id, third);
  assert.equal((await feed.browse({ page: home.sections[0].morePage, offset: 1 })).sections[0].tracks[0].id, other);
  assert.deepEqual(requests.map(body => body.browseId || body.continuation), ['FEwhat_to_watch', 'FEtopics_music', 'music-more']);
});

test('Shorts sequence without inline metadata batches official account details and keeps the returned order', async () => {
  session(); let metadataRequests = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/shorts/')) return reply('var ytInitialData = {"sequenceContinuation":"sequence"};');
    if (url.includes('youtube.googleapis.com/youtube/v3/videos?')) {
      metadataRequests++;
      assert.equal(options.headers.authorization, 'Bearer fixture-token');
      assert.equal(new URL(url).searchParams.get('id'), [other, id, third].join(','));
      return reply({ items: [id, other].map(id => ({ id, snippet: { title: 'Short ' + id, channelId: 'UCfixture', channelTitle: 'Creator' }, contentDetails: { duration: 'PT27S' } })) });
    }
    const body = JSON.parse(options.body);
    if (url.includes('/browse?')) return reply(page([shelf('推荐视频', [tile(id)])]));
    assert.equal(body.sequenceParams, 'sequence');
    return reply({ ...tracking, entries: [other, id, third].map(videoId => ({ command: { reelWatchEndpoint: { videoId,
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/portrait', width: 1080, height: 1920 }] } } } })), continuation: 'sequence-next' });
  };
  const result = await feed.browse({ page: 'shorts' });
  assert.deepEqual(result.sections[0].tracks.map(t => t.id), [other, id]);
  assert.equal(result.sections[0].tracks[0].duration, 27_000);
  assert.equal(result.sections[0].tracks[0].video.height, 1920);
  assert.equal(result.more, true); assert.equal(metadataRequests, 1);
});

test('shelf More starts at its real homepage snapshot then reads only its own whole-page continuation', async () => {
  session(); const calls = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body); calls.push(body);
    if (!body.continuation) return reply(page([shelf('推荐的音乐视频', [tile(id)], 'music-cursor'), shelf('Shorts', [tile(third, true)], undefined, true), shelf('推荐视频', [tile(other)])]));
    assert.equal(body.continuation, 'music-cursor');
    return reply({ ...tracking, continuationContents: { sectionListContinuation: { contents: [
      shelf('推荐视频', [tile(third)], 'unrelated-cursor'), shelf('推荐的音乐视频', [tile(id), tile(other)], 'own-cursor')
    ] } } });
  };
  const home = await feed.home(), route = home.sections[0].morePage;
  const first = await feed.browse({ page: route });
  assert.deepEqual(first.sections[0].tracks.map(t => t.id), [id]);
  assert.equal(first.sections[0].morePage, undefined); assert.equal(first.more, true);
  assert.equal(calls.length, 1, 'opening More does not skip the first shelf page');
  const next = await feed.browse({ page: route, offset: 1 });
  assert.deepEqual(next.sections[0].tracks.map(t => t.id), [other]);
  assert.equal(next.more, true);
  const cursor = data.get('youtube.feed.pages.v1')[route + ':2'];
  assert.equal(cursor.token, 'own-cursor'); assert.deepEqual(cursor.seen, [id, other]);
});

test('shelf continuation skips overlapping pages and never substitutes an unrelated shelf', async () => {
  session(); let stage = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body);
    if (!body.continuation) return reply(page([shelf('推荐音乐视频', [tile(id)], 'overlap'), shelf('Shorts', [tile(third, true)], undefined, true), shelf('推荐视频', [tile(other)])]));
    stage++;
    if (body.continuation === 'overlap') return reply({ ...tracking, continuationContents: { horizontalListContinuation: { items: [tile(id)], ...next('fresh') } } });
    assert.equal(body.continuation, 'fresh');
    return reply({ ...tracking, continuationContents: { sectionListContinuation: { contents: [shelf('其他推荐', [tile(third)]), shelf('推荐音乐视频', [tile(other)])] } } });
  };
  const home = await feed.home(), route = home.sections[0].morePage;
  await feed.browse({ page: route });
  const more = await feed.browse({ page: route, offset: 1 });
  assert.deepEqual(more.sections[0].tracks.map(t => t.id), [other]);
  assert.equal(stage, 2); assert.equal(more.more, false);
});

test('stored shelf snapshot and cursor survive module reload and reset drops account-scoped snapshots', async () => {
  session();
  globalThis.fetch = async url => reply(url.includes('/guide?') ? guide : page([shelf('推荐音乐视频', [tile(id)], 'next'), shelf('Shorts', [tile(other, true)], undefined, true), shelf('推荐视频', [tile(third)])]));
  const home = await feed.home(), route = home.sections[0].morePage;
  const restarted = await import('./youtube-feed.js?shelf-reload=1');
  assert.equal((await restarted.browse({ page: route })).sections[0].tracks[0].id, id);
  restarted.resetFeeds();
  await assert.rejects(restarted.browse({ page: route }), /预览已失效/);
  assert.deepEqual(data.get('youtube.feed.shelves.v1'), {});
});
