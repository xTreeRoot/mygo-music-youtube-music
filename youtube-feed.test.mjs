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
  { guideEntryRenderer: { formattedTitle: { simpleText: '音乐' }, navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_music' } } } }] };
function session() { data.clear(); data.set('oauthSession', { active: true, access: 'fixture-token', expires: Date.now() + 3_600_000 }); feed.resetFeeds(); }
const id = '00000000001', other = '00000000002', third = '00000000003';

test('signed-in home forwards native authorization only through TV feed and preserves real shelves and topic routes', async () => {
  session(); const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    assert.equal(options.headers['x-youtube-client-name'], '7');
    const body = JSON.parse(options.body); assert.equal(body.context.client.clientName, 'TVHTML5'); requests.push(body);
    if (url.includes('/guide?')) return reply(guide);
    return reply(page([shelf('为你推荐', [tile(id)], 'shelf-next'), shelf('Shorts', [tile(other, true)], 'short-next', true)], 'home-next'));
  };
  const home = await feed.home();
  assert.deepEqual(home.sections.map(s => s.title), ['为你推荐', 'Shorts']);
  assert.equal(home.sections[0].morePage.startsWith('yt-feed:'), true);
  assert.equal(JSON.parse(decodeURIComponent(home.sections[0].morePage.slice(8))).request.continuation, 'shelf-next');
  assert.deepEqual(home.tabs.map(t => t.title), ['全部', '音乐']);
  assert.equal(JSON.parse(decodeURIComponent(home.tabs[1].page.slice(8))).request.browseId, 'FEtopics_music');
  assert.equal(home.sections[1].tracks[0].video.height, 1920);
  assert.equal(home.sections[1].tracks[0].album.imageUrl, 'https://i.ytimg.com/portrait');
  assert.equal(requests[0].browseId, 'FEwhat_to_watch');
});

test('topics and home vertical continuation survive module reload while stale cursor is discarded after refresh', async () => {
  session(); const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/guide?')) return reply(guide);
    const body = JSON.parse(options.body); requests.push(body);
    return reply(body.continuation ? { ...tracking, continuationContents: { sectionListContinuation: { contents: [shelf('第二页', [tile(other)])] } } } : page([shelf('推荐', [tile(id)])], 'next-home'));
  };
  assert.equal((await feed.browse({ page: 'feed:home' })).more, true);
  const restored = await import('./youtube-feed.js?restart=1');
  const second = await restored.browse({ page: 'feed:home', offset: 1 });
  assert.equal(second.sections[0].tracks[0].id, other); assert.equal(second.more, false);
  assert.equal(requests.at(-1).continuation, 'next-home');
  data.set('youtube.feed.pages.v1', { 'feed:home:99': { token: 'stale' } });
  await feed.browse({ page: 'feed:home' });
  assert.equal(data.get('youtube.feed.pages.v1')['feed:home:99'], undefined);
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
    return reply(page([shelf('推荐', [tile(id)])]));
  };
  const first = await feed.home();
  assert.equal(first.sections[0].tracks[0].id, id); assert.deepEqual(first.tabs, []);
  const second = await feed.home();
  assert.deepEqual(second.tabs.map(item => item.title), ['全部', '音乐']);
});

test('invalid routes cannot inject arbitrary browse endpoint or more than one parameter', async () => {
  session(); globalThis.fetch = async () => { throw new Error('must not request'); };
  for (const request of [{ browseId: 'arbitrary' }, { browseId: 'FEtopics_music', continuation: 'x' }, { continuation: 42 }]) {
    await assert.rejects(feed.browse({ page: 'yt-feed:' + encodeURIComponent(JSON.stringify({ request, title: 'x' })) }), /无效/);
  }
});
