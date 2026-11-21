// 系统 OAuth 登录、刷新与独立会话存储；不访问或同步浏览器 Cookie。
// 公开原生客户端标识；每个平台使用 Google 控制台中对应类型的客户端。
const clients = {
  ios: {
    clientID: "917134708837-jg4va90dtmb2bcme3vsoukfq149htrp5.apps.googleusercontent.com",
    redirectURI: "com.googleusercontent.apps.917134708837-jg4va90dtmb2bcme3vsoukfq149htrp5:/oauthredirect",
  },
  android: {
    clientID: "917134708837-7485b4m60npe0htgob42mtotnma12gn1.apps.googleusercontent.com",
    redirectURI: "com.xtreeroot.mb:/oauth2redirect",
  },
};
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const storageKey = "oauthSession";
let candidate = null;
let revision = 0;
let refreshing = null;
let signingIn = false;

const saved = () => host.storage.get(storageKey);
export const isOAuthSignInPending = () => signingIn;
export const hasOAuth = () => Boolean(candidate || saved()?.active);

function sessionClientID(session) {
  // 0.1.7 及以前仅有 iOS OAuth，会话尚未包含客户端字段。
  const clientID = session.clientID ?? clients.ios.clientID;
  if (!Object.values(clients).some(client => client.clientID === clientID)) throw new Error("Google 登录配置已改变，请重新登录");
  return clientID;
}

function checkedTokens(value, previous, clientID = sessionClientID(previous || {})) {
  if (typeof value?.access_token !== "string" || !value.access_token || /[\r\n]/.test(value.access_token) ||
      String(value.token_type).toLowerCase() !== "bearer" || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) {
    throw new Error("Google 未返回有效的登录令牌，请重新登录");
  }
  return {
    access: value.access_token,
    refresh: typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : previous?.refresh,
    expires: Date.now() + Number(value.expires_in) * 1000,
    clientID,
    active: true,
    scopes: typeof value.scope === "string" ? value.scope.split(/\s+/) : previous?.scopes,
  };
}

async function refreshSession(session, generation) {
  if (session.expires > Date.now() + 60000) return session;
  if (!session.refresh) throw new Error("YouTube 登录已过期，请重新登录");
  const response = await fetch(tokenEndpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: sessionClientID(session), grant_type: "refresh_token", refresh_token: session.refresh }).toString(),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if (generation === revision && !signingIn && failure.error === "invalid_grant") endOAuth();
    throw new Error("YouTube 登录刷新失败，请重新登录");
  }
  const updated = checkedTokens(await response.json(), session);
  if (generation !== revision) throw new Error("登录状态已改变，请重试");
  if (candidate === session) candidate = updated;
  else host.storage.set(storageKey, updated);
  return updated;
}

export async function oauthHeaders() {
  const session = candidate || saved();
  if (!session?.active) return {};
  const generation = revision;
  if (!refreshing || refreshing.generation !== generation || refreshing.session.access !== session.access ||
      refreshing.session.refresh !== session.refresh || refreshing.session.expires !== session.expires || refreshing.session.clientID !== session.clientID) {
    refreshing = { session, generation, promise: refreshSession(session, generation) };
  }
  const pending = refreshing;
  try {
    const current = await pending.promise;
    if (generation !== revision) throw new Error("登录状态已改变，请重试");
    return { authorization: `Bearer ${current.access}`, "x-goog-request-time": String(Math.floor(Date.now() / 1000)) };
  } finally { if (refreshing === pending) refreshing = null; }
}

export async function signInOAuth(verify, scopes = ["https://www.googleapis.com/auth/youtube"]) {
  if (typeof host.oauthSignIn !== "function") throw new Error("请更新 MB，以使用 Google 系统授权登录");
  const client = clients[host.platform];
  if (!client) throw new Error("当前平台尚未配置 Google 系统授权登录");
  if (signingIn) throw new Error("Google 登录正在进行中");
  signingIn = true;
  const generation = ++revision;
  candidate = null;
  const previous = saved();
  try {
    // 重新登录先验证本机保留的会话，不把退出登录等同于删除账号资料。
    if (previous?.refresh && (scopes.length === 1 || scopes.every(scope => previous.scopes?.includes(scope)))) {
      candidate = { ...previous, active: true };
      try {
        const me = await verify();
        if (generation !== revision) throw new Error("登录状态已改变，请重试");
        if (me) { host.storage.set(storageKey, candidate); return me; }
      } catch (error) { if (generation !== revision) throw error; }
      candidate = null;
    }
    const result = await host.oauthSignIn({
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint, ...client,
      scopes,
    });
    if (generation !== revision) throw new Error("登录状态已改变，请重试");
    candidate = checkedTokens(result, undefined, client.clientID);
    candidate.scopes ??= scopes;
    const me = await verify();
    if (generation !== revision) throw new Error("登录状态已改变，请重试");
    if (!me) throw new Error("YouTube Music 没有接受这次授权，请重试");
    host.storage.set(storageKey, candidate);
    return me;
  } finally { if (generation === revision) { candidate = null; signingIn = false; } }
}

export function endOAuth() {
  revision += 1; candidate = null; refreshing = null; signingIn = false;
  const session = saved();
  if (session) host.storage.set(storageKey, { ...session, active: false });
}
