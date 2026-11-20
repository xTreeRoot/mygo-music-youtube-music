import test from 'node:test';
import assert from 'node:assert/strict';

let sequence = 0;
const account = { items: [{ id: 'UCfixture', snippet: { title: 'Fixture', thumbnails: { default: { url: 'https://yt3.ggpht.com/fixture' } } } }] };
const tokens = (access = 'synthetic-access') => ({ access_token: access, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer' });
const session = (extra = {}) => ({ access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3600000, active: true, ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

async function setup(initial = {}) {
  const storage = new Map();
  const requests = [];
  globalThis.host = { platform: 'ios', t: text => text, language: () => 'en', storage: {
    // Match the native host's serialized value semantics.
    get: key => storage.has(key) ? structuredClone(storage.get(key)) : null,
    set: (key, value) => storage.set(key, structuredClone(value)),
  }, oauthSignIn: async () => tokens(), webSignIn: () => { throw Error('embedded login must not open'); } };
  globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); return response(account); };
  const plugin = await import(`./index.js?oauth-test=${++sequence}`);
  plugin.signOut();
  storage.clear();
  for (const [key, value] of Object.entries(initial)) storage.set(key, value);
  return { plugin, storage, requests };
}

test('iOS uses system OAuth, validates with Bearer and preserves disabled sessions for reuse', async () => {
  const { plugin, storage, requests } = await setup({ cookie: 'synthetic-cookie' });
  let prompts = 0;
  host.oauthSignIn = async options => {
    prompts++;
    assert.equal(options.authorizationEndpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(options.tokenEndpoint, 'https://oauth2.googleapis.com/token');
    assert.ok(options.clientID.endsWith('.apps.googleusercontent.com'));
    assert.deepEqual(options.scopes, ['https://www.googleapis.com/auth/youtube']);
    return tokens();
  };
  assert.equal((await plugin.signIn()).id, 'UCfixture');
  assert.equal(prompts, 1);
  assert.equal(requests[0].url, 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-access');
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(storage.get('cookieActive'), false);
  plugin.signOut();
  assert.equal(storage.get('oauthSession').active, false);
  assert.equal(storage.get('oauthSession').refresh, 'synthetic-refresh');
  assert.equal(storage.get('cookie'), 'synthetic-cookie');
  assert.equal(await plugin.account(), null);
  assert.equal((await plugin.signIn()).name, 'Fixture');
  assert.equal(prompts, 1, 'valid saved session is reused before asking again');
});

test('rejected saved OAuth can open a fresh login and failed validation does not replace the old session', async () => {
  const previous = session();
  const { plugin, storage } = await setup({ oauthSession: previous });
  let prompted = 0;
  host.oauthSignIn = async () => { prompted++; assert.deepEqual(storage.get('oauthSession'), previous); return tokens('new-access'); };
  globalThis.fetch = async (_url, options) => response(account, options.headers.authorization === 'Bearer old-access' ? 401 : 200);
  assert.equal((await plugin.signIn()).name, 'Fixture');
  assert.equal(prompted, 1);
  assert.equal(storage.get('oauthSession').access, 'new-access');
  const beforeFailure = structuredClone(storage.get('oauthSession'));
  globalThis.fetch = async () => response({}, 401);
  await assert.rejects(plugin.signIn());
  assert.deepEqual(storage.get('oauthSession'), beforeFailure);
});

test('cancelled system login retains old data and sign-out rejects a late successful authorization', async () => {
  const previous = session({ active: false });
  const { plugin, storage } = await setup({ oauthSession: previous });
  globalThis.fetch = async () => response({}, 401);
  host.oauthSignIn = async () => { throw Error('cancelled'); };
  await assert.rejects(plugin.signIn(), /cancelled/);
  assert.deepEqual(storage.get('oauthSession'), previous);
  let release;
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  host.oauthSignIn = () => { opened(); return new Promise(resolve => { release = resolve; }); };
  const login = plugin.signIn();
  await ready;
  plugin.signOut();
  release(tokens('late-access'));
  await assert.rejects(login, /登录状态已改变/);
  assert.equal(storage.get('oauthSession').active, false);
  assert.equal(storage.get('oauthSession').access, previous.access);
});

test('parallel account requests share a refresh and never send credentials to anonymous media requests', async () => {
  const { plugin, storage, requests } = await setup({ oauthSession: session({ expires: 0 }) });
  let refreshes = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshes++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'old-refresh');
      assert.equal(form.has('client_secret'), false);
      await new Promise(resolve => setImmediate(resolve));
      return response({ ...tokens('renewed'), refresh_token: undefined });
    }
    if (url.includes('/visitor_id')) return response({ responseContext: { visitorData: 'fixture' } });
    if (url.includes('/player')) return response({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [
      { mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://r1.googlevideo.com/audio', bitrate: 128000 },
    ] } });
    return response(account);
  };
  assert.equal((await Promise.all([plugin.account(), plugin.account()])).length, 2);
  assert.equal(refreshes, 1);
  assert.equal(storage.get('oauthSession').refresh, 'old-refresh');
  await plugin.stream({ id: 'dQw4w9WgXcQ' });
  assert.ok(requests.filter(request => request.url.includes('/channels?')).every(request => request.headers.authorization === 'Bearer renewed'));
  assert.ok(requests.filter(request => /\/(visitor_id|player)/.test(request.url)).every(request => !request.headers.authorization && !request.headers.cookie));
});

test('temporary refresh failures preserve sessions, invalid_grant deactivates them, and late refresh cannot undo sign-out', async () => {
  const original = session({ expires: 0 });
  const { plugin, storage } = await setup({ oauthSession: original });
  globalThis.fetch = async () => { throw Error('offline'); };
  await assert.rejects(plugin.account(), /offline/);
  assert.deepEqual(storage.get('oauthSession'), original);
  globalThis.fetch = async () => response({ error: 'invalid_grant' }, 400);
  await assert.rejects(plugin.account(), /刷新失败/);
  assert.equal(storage.get('oauthSession').active, false);
  storage.set('oauthSession', original);
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const request = plugin.account();
  await ready;
  plugin.signOut();
  release(response(tokens('late-refresh')));
  await assert.rejects(request, /登录状态已改变/);
  assert.equal(storage.get('oauthSession').active, false);
  assert.equal(storage.get('oauthSession').access, original.access);
});

// Reproduce the native-token account_menu 400 without accepting an unverified identity.
test('native OAuth never calls account_menu and rejects missing channels or official API failures', async () => {
  const { plugin, storage, requests } = await setup();
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return url.includes('/account/account_menu') ? response({}, 400) : response(account);
  };
  assert.equal((await plugin.signIn()).id, 'UCfixture');
  assert.ok(requests.every(request => request.url.startsWith('https://youtube.googleapis.com/youtube/v3/channels?')));
  const saved = structuredClone(storage.get('oauthSession'));
  globalThis.fetch = async () => response({ items: [] });
  await assert.rejects(plugin.signIn(), /没有可用的 YouTube 频道/);
  assert.deepEqual(storage.get('oauthSession'), saved);
  globalThis.fetch = async () => response({}, 403);
  await assert.rejects(plugin.signIn(), /HTTP 403/);
  assert.deepEqual(storage.get('oauthSession'), saved);
});

test('OAuth discovery rejected with 400 retries the public home without clearing the account', async () => {
  const original = session();
  const { plugin, storage } = await setup({ oauthSession: original });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (options.headers.authorization) return response({ error: { code: 400 } }, 400);
    const body = JSON.parse(options.body);
    return response(body.continuation ? {} : { contents: { sectionListRenderer: { continuations: [{ nextContinuationData: { continuation: 'public-next' } }] } } });
  };
  const home = await plugin.home();
  assert.ok(Array.isArray(home.sections));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.authorization, 'Bearer old-access');
  for (const request of requests.slice(1)) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
  }
  assert.equal(JSON.parse(requests[2].body).continuation, 'public-next');
  assert.deepEqual(storage.get('oauthSession'), original);
});

test('discovery does not hide server errors or retry account libraries as a visitor', async () => {
  const { plugin } = await setup({ oauthSession: session() });
  let count = 0;
  globalThis.fetch = async () => { count++; return response({}, 503); };
  await assert.rejects(plugin.home(), /503/);
  assert.equal(count, 1);
  globalThis.fetch = async () => { count++; return response({}, 400); };
  await assert.rejects(plugin.liked({ offset: 0 }), /400/);
  assert.equal(count, 2);
});
