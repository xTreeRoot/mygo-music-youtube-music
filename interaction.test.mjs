/** 互动总数只读取真实 statistics，不能拿当前页评论条数冒充总数。 */
import test from 'node:test';
import assert from 'node:assert/strict';
let serial = 0;
test('YouTube totals request statistics explicitly and leave hidden counts absent', async () => {
  const previous = { host: globalThis.host, fetch: globalThis.fetch };
  try {
    globalThis.host = { platform: 'android', language: () => 'en', t: text => text, storage: {
      get: key => key === 'oauthSession' ? {active: true, access: 'fixture', refresh: 'fixture', expires: Date.now()+600000} : null,
      set: () => {},
    } };
    let statistics = { likeCount: '18234', commentCount: '0' };
    globalThis.fetch = async input => {
      const url = new URL(input);
      assert.equal(url.pathname, '/youtube/v3/videos');
      assert.equal(url.searchParams.get('part'), 'statistics');
      assert.equal(url.searchParams.get('fields'), 'items(statistics(likeCount,commentCount))');
      return {ok: true, status:200, json:async()=>({items:[{statistics}]})};
    };
    const plugin = await import(`./index.js?interaction=${++serial}`);
    assert.deepEqual(await plugin.interactionSummary({trackId:'jNQXAC9IVRw'}), {likes:18234,comments:0});
    statistics = {likeCount:'hidden',commentCount:'9007199254740992'};
    assert.deepEqual(await plugin.interactionSummary({trackId:'jNQXAC9IVRw'}), {});
    await assert.rejects(plugin.interactionSummary({trackId:'invalid'}), /无效/);
  } finally { Object.assign(globalThis, previous); }
});
