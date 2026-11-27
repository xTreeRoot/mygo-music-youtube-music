import test from 'node:test';
import assert from 'node:assert/strict';
const data=new Map();
globalThis.host={t:x=>x,platform:'android',language:()=> 'zh-CN',storage:{get:key=>data.get(key),set:(key,value)=>data.set(key,value)}};
const web=await import('./youtube-web.js');
const plugin=await import('./index.js');
const cfg={INNERTUBE_CONTEXT_CLIENT_NAME:1,INNERTUBE_API_KEY:'public-config',INNERTUBE_CONTEXT:{client:{clientName:'WEB',clientVersion:'fixture-current'}}};
const id='dQw4w9WgXcQ';
const row=(id,name='Ordinary video')=>({videoRenderer:{videoId:id,title:{runs:[{text:name}]},thumbnail:{thumbnails:[{url:'https://i.ytimg.com/wide'}]},longBylineText:{runs:[{text:'Creator'}]},lengthText:{simpleText:'2:31'}}});
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,text:async()=>typeof value==='string'?value:JSON.stringify(value)});
function session(){data.set('oauthSession',{active:true,access:'fixture-token',expires:Date.now()+3_600_000});}
function guest(){data.clear();}
test('configuration ignores scalar ytcfg calls and public search never forwards native Bearer',async()=>{
 session();let count=0;globalThis.fetch=async(url,options)=>{
  if(url.includes('/?hl='))return reply(`ytcfg.set('EMERGENCY','x');(function(){window.x=1;})();ytcfg.set(${JSON.stringify(cfg)});`);
  assert.equal(options.headers.authorization,undefined);const request=JSON.parse(options.body);assert.equal(request.context.client.clientVersion,'fixture-current');count++;
  return reply({contents:[row(id)],tail:{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:count===1?'page2':undefined}}}}});
 };
 const first=await plugin.search({query:'non music'});assert.equal(first.tracks[0].name,'Ordinary video');assert.equal(first.tracks[0].duration,151000);assert.equal(first.more,true);
 assert.equal((await plugin.search({query:'non music',offset:1})).tracks.length,1);
 assert.deepEqual(await plugin.search({query:'non music',offset:2}),{tracks:[],more:false});guest();
});
test('ordinary home uses video feed and Shorts parses server sequence metadata and resumes its token',async()=>{
 guest();let sequence=0;globalThis.fetch=async(url,options)=>{
  if(url.endsWith('/shorts/'))return reply('var ytInitialData = '+JSON.stringify({sequenceContinuation:'start'})+';');
  const b=JSON.parse(options.body);
  if(url.includes('/browse?'))return reply({contents:[row(id)]});
  assert.ok(url.includes('reel_watch_sequence'));assert.ok(['start','next-sequence'].includes(b.sequenceParams)); sequence++;
  return reply({entries:[{command:{reelWatchEndpoint:{videoId:id,thumbnail:{thumbnails:[{url:'https://i.ytimg.com/portrait',width:1080,height:1920}]},unserializedPrefetchData:{playerResponse:{videoDetails:{videoId:id,title:'Short fixture',lengthSeconds:'27',author:'Creator'}}}}}}],continuationEndpoint:{continuationCommand:{token:b.sequenceParams==='start'?'next-sequence':undefined}}});
 };
 const home=await plugin.home();assert.equal(home.sections.at(-1).tracks[0].name,'Ordinary video');
 const first=await plugin.browse({page:'shorts'});assert.equal(first.more,true);const track=first.sections[0].tracks[0];assert.equal(track.video.short,true);assert.equal(track.video.height,1920);
 const second=await plugin.browse({page:'shorts',offset:1});assert.equal(second.more,false);assert.equal(sequence,3);
});
test('public comments read modern entities and only top-level continuation',async()=>{
 guest();let count=0;globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);count++;
  if(body.videoId)return reply({contents:{itemSectionRenderer:{sectionIdentifier:'comment-item-section',contents:[{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'top'}}}}]}}});
  assert.equal(body.continuation,'top');return reply({frameworkUpdates:{entityBatchUpdate:{mutations:[{payload:{commentEntityPayload:{key:'entity',properties:{commentId:'c1',content:{content:'Actual comment'}},author:{displayName:'Listener'},toolbar:{likeCountNotliked:'12'}}}}]}},onResponseReceivedEndpoints:[{reloadContinuationItemsCommand:{targetId:'comments-section',continuationItems:[{commentThreadRenderer:{commentViewModel:{commentViewModel:{commentKey:'entity'}},replies:{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'replies'}}}}}}]}}]});
 };
 const result=await plugin.comments({trackId:id});assert.equal(result.comments[0].text,'Actual comment');assert.equal(result.comments[0].likes,12);assert.equal(result.more,false);assert.equal(count,2);
});
test('caption timing uses unsigned native-player track and keeps multiline text',async()=>{
 guest();globalThis.fetch=async(url,options)=>{
  if(url.includes('visitor_id'))return reply({responseContext:{visitorData:'fixture'}});
  if(url.includes('/player?')){assert.equal(JSON.parse(options.body).context.client.clientName,'VISIONOS');return reply({captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v='+id}]}}});}
  assert.ok(url.includes('fmt=json3'));return reply({events:[{tStartMs:100,dDurationMs:500,segs:[{utf8:'Hello\nworld'}]},{tStartMs:700,segs:[{utf8:'Next'}]}]});
 };
 assert.deepEqual((await plugin.lyrics({id})).lines,[{start:100,end:600,text:'Hello world'},{start:700,end:4700,text:'Next'}]);
});
test('playlist reads and inserts are exposed while disabled comments return an empty page',async()=>{
 session();
 assert.equal(typeof plugin.playlists,'function');assert.equal(typeof plugin.addToPlaylist,'function');assert.equal(typeof plugin.removeFromPlaylist,'function');assert.equal(plugin.recent,undefined);assert.equal(plugin.played,undefined);
 globalThis.fetch=async()=>reply({error:{errors:[{reason:'commentsDisabled'}]}},403);
 assert.deepEqual(await plugin.comments({trackId:'00000000001'}),{comments:[],more:false});guest();
});
test('search metadata preserves portrait thumbnails and channel links',()=>{
 const tracks=web.videos({contents:[row(id),{shortsLockupViewModel:{onTap:{innertubeCommand:{reelWatchEndpoint:{videoId:'00000000001',thumbnail:{thumbnails:[{url:'https://i.ytimg.com/short',width:1080,height:1920}]}}}},overlayMetadata:{primaryText:{content:'Short'}}}}]});assert.equal(tracks.length,2);assert.equal(tracks[1].video.short,true);assert.equal(tracks[1].album.imageUrl,'https://i.ytimg.com/short');
});
test('new login requests comment permission while cancellation keeps an existing account',async()=>{
 session();const previous=data.get('oauthSession');let prompts=0;
 host.oauthSignIn=async options=>{prompts++;assert.ok(options.scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl'));throw new Error('cancelled');};
 await assert.rejects(plugin.signIn(),/cancelled/);assert.equal(data.get('oauthSession'),previous);assert.equal(prompts,1);
 guest();host.oauthSignIn=async()=>({access_token:'fixture-new',refresh_token:'fixture-refresh',expires_in:3600,token_type:'Bearer'});
 globalThis.fetch=async()=>reply({items:[{id:'UCfixture',snippet:{title:'Fixture account'}}]});
 await plugin.signIn();assert.ok(data.get('oauthSession').scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl'));guest();
});
test('signed-in channel and playlist search use typed official requests and channel uploads paginate',async()=>{
 session();let searches=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(options.headers.authorization,'Bearer fixture-token');
  const query=new URL(url).searchParams;
  if(url.includes('/search?')){searches++;const channel=query.get('type')==='channel';return reply({items:[{id:channel?{channelId:'UCfixture'}:{playlistId:'PLfixture'},snippet:{title:channel?'Creator':'List'}}]});}
  if(url.includes('/channels?'))return reply({items:[{id:'UCfixture',snippet:{title:'Fixture Creator',description:'Channel introduction',thumbnails:{default:{url:'https://example.test/avatar.jpg'}}},contentDetails:{relatedPlaylists:{uploads:'UUfixture'}}}]});
  assert.ok(url.includes('/playlistItems?'));
  const second=query.has('pageToken');return reply({items:[{id:'entry',snippet:{title:'Video',resourceId:{videoId:id}}}],...(second?{}:{nextPageToken:'page2'})});
 };
 assert.equal((await plugin.search({query:'creator',kind:'artists'})).artists[0].id,'UCfixture');
 assert.equal((await plugin.search({query:'list',kind:'playlists'})).playlists[0].id,'PLfixture');
 assert.equal(searches,2);
 const author=await plugin.artist({id:'UCfixture'}); assert.equal(author.more,true); assert.equal(author.artist.name,'Fixture Creator'); assert.equal(author.artist.description,'Channel introduction');
 assert.equal((await plugin.artist({id:'UCfixture',offset:1})).more,false);guest();
});

test('playlist insert checks ownership and sends the official snippet without local fallback',async()=>{
 session();const writes=[];
 globalThis.fetch=async(address,options)=>{
  const url=new URL(address);
  if(url.pathname.endsWith('/playlists'))return reply({items:[{id:'PLfixture',snippet:{title:'Mine'}}]});
  assert.ok(url.pathname.endsWith('/playlistItems'));assert.equal(options.method,'POST');
  writes.push(JSON.parse(options.body));return reply({id:'added'});
 };
 await plugin.addToPlaylist({id:'PLfixture',trackIds:[id,id]});
 assert.deepEqual(writes,[{snippet:{playlistId:'PLfixture',resourceId:{kind:'youtube#video',videoId:id}}}]);
 await assert.rejects(plugin.addToPlaylist({id:'foreign',trackIds:[id]}),/本人/);assert.equal(writes.length,1);
 await assert.rejects(plugin.addToPlaylist({id:'PLfixture',trackIds:['bad']}),/无效/);guest();
});

test('playlist removal resolves entry IDs over all pages before issuing deletes',async()=>{
 session();const deleted=[];
 globalThis.fetch=async(address,options)=>{
  const u=new URL(address),q=u.searchParams;
  if(u.pathname.endsWith('/playlists'))return reply({items:[{id:'PLfixture',snippet:{title:'Mine'}}]});
  if(options.method==='DELETE'){deleted.push(q.get('id'));return {ok:true,status:204};}
  return reply(q.has('pageToken')?{items:[{id:'entry2',contentDetails:{videoId:id}}]}:{items:[{id:'other',contentDetails:{videoId:'00000000001'}}],nextPageToken:'next'});
 };
 await plugin.removeFromPlaylist({id:'PLfixture',trackIds:[id]});assert.deepEqual(deleted,['entry2']);guest();
});
