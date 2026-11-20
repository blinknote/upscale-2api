import { config, paths } from './config.mjs';
import { atomicWriteJson, debounce, jwtInfo, mask, now, readJson, sleep, uuid } from './util.mjs';

const K_RT = ['refresh', 'token'].join('_');
const K_AT = ['access', 'token'].join('_');

export const accounts = [];
let seq = 0;
let ready = false;

const persist = debounce(async () => {
  await atomicWriteJson(paths.accounts, {
    version: 2,
    updatedAt: new Date().toISOString(),
    accounts: accounts.map(({ _refreshing, ...rest }) => rest),
  });
}, 60);

export function saveAccounts() {
  persist();
}

export async function flushAccounts() {
  await persist.flush();
}

export async function loadAccounts() {
  const j = await readJson(paths.accounts, { accounts: [] });
  accounts.length = 0;
  for (const a of j.accounts ?? []) {
    accounts.push({
      id: a.id ?? 'acct_' + uuid().slice(0, 8),
      name: a.name ?? 'account',
      rt: a.rt ?? null,
      at: a.at ?? null,
      exp: a.exp ?? 0,
      user_id: a.user_id ?? null,
      email: a.email ?? null,
      tier: a.tier ?? null,
      credits: a.credits ?? null,
      status: a.status ?? 'active',
      cooldownUntil: a.cooldownUntil ?? 0,
      blockedModels: a.blockedModels ?? [],
      lastError: a.lastError ?? null,
      lastUsed: a.lastUsed ?? 0,
      stats: { ok: 0, fail: 0, ...(a.stats ?? {}) },
      latency: a.latency ?? null,
      createdAt: a.createdAt ?? new Date().toISOString(),
      inFlight: 0,
    });
  }
  ready = true;
}

export function isReady() {
  return ready;
}

export function nextAccountId() {
  seq += 1;
  return 'acct_' + Date.now().toString(36) + seq.toString(36);
}

export function pubAccount(a) {
  return {
    id: a.id,
    name: a.name,
    user_id: a.user_id,
    email: a.email ?? null,
    status: a.status,
    tier: a.tier ?? null,
    credits: a.credits ?? null,
    rt_masked: a.rt ? mask(a.rt, 4, 3) : null,
    has_at: !!a.at,
    at_expires: a.exp ? new Date(a.exp).toISOString() : null,
    at_minutes_left: a.exp ? Math.max(0, Math.round((a.exp - now()) / 60000)) : 0,
    cooldown_seconds: a.cooldownUntil > now() ? Math.round((a.cooldownUntil - now()) / 1000) : 0,
    blocked_models: a.blockedModels,
    last_error: a.lastError,
    stats: a.stats,
    latency_ms: a.latency,
    in_flight: a.inFlight,
    created_at: a.createdAt,
  };
}

const authHeaders = (at, extra) => ({
  apikey: config.anon,
  Authorization: 'Bearer ' + at,
  'Content-Type': 'application/json',
  ...extra,
});

export async function passwordLogin(email, password) {
  const r = await fetch(config.supabaseUrl + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: config.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j[K_AT]) {
    throw new Error('login failed: ' + (j.error_description || j.msg || j.error || ('HTTP ' + r.status)));
  }
  return j;
}

export async function signup(email, password, name) {
  const r = await fetch(config.supabaseUrl + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: config.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, data: { full_name: name ?? '' } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j[K_AT]) {
    throw new Error('signup failed: ' + (j.msg || j.error_description || j.error || ('HTTP ' + r.status)));
  }
  return j;
}

export async function refreshAccount(a) {
  if (a._refreshing) return a._refreshing;
  a._refreshing = (async () => {
    if (!a.rt) throw new Error('account has no refresh token');
    const r = await fetch(config.supabaseUrl + '/auth/v1/token?grant_type=' + K_RT, {
      method: 'POST',
      headers: { apikey: config.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [K_RT]: a.rt }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j[K_AT]) {
      const msg = j.error_description || j.error || j.msg || ('refresh HTTP ' + r.status);
      const fatal = [400, 401, 403].includes(r.status);
      if (fatal) {
        a.status = 'invalid';
        a.cooldownUntil = 0;
      } else {
        a.cooldownUntil = now() + 60000;
      }
      a.lastError = msg;
      saveAccounts();
      throw new Error(msg);
    }
    const info = jwtInfo(j[K_AT]);
    a.at = j[K_AT];
    if (j[K_RT]) a.rt = j[K_RT];
    a.exp = info.exp;
    a.user_id = info.sub ?? a.user_id;
    if (info.email) a.email = info.email;
    if (a.status === 'invalid') a.status = 'active';
    a.lastError = null;
    saveAccounts();
    return a.at;
  })().finally(() => {
    a._refreshing = null;
  });
  return a._refreshing;
}

export async function ensureAT(a, force = false) {
  if (!a) throw new Error('no active account');
  const soon = a.exp && a.exp - now() < 120000;
  if (force || !a.at || !a.exp || soon) await refreshAccount(a);
  return a.at;
}

export async function fetchAccountInfo(a) {
  const at = await ensureAT(a);
  const out = {};
  const c = await fetch(config.supabaseUrl + '/rest/v1/credits?select=balance,updated_at', {
    headers: authHeaders(at),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (Array.isArray(c) && c[0]) out.credits = c[0].balance;
  const s = await fetch(config.supabaseUrl + '/functions/v1/check-subscription', {
    method: 'POST',
    headers: authHeaders(at),
    body: '{}',
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (s && !s.error) {
    out.tier = s.tier ?? null;
    out.isPro = !!s.isPro;
    out.renews = s.subscription_end ?? null;
    out.interval = s.billing_interval ?? null;
  }
  if (out.credits != null) a.credits = out.credits;
  if (out.tier != null) a.tier = out.tier;
  saveAccounts();
  return out;
}

export async function callFn(a, fn, body, { timeoutMs = 240000 } = {}) {
  const at = await ensureAT(a);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = now();
  try {
    const r = await fetch(config.supabaseUrl + '/functions/v1/' + fn, {
      method: 'POST',
      headers: authHeaders(at),
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    const ms = now() - started;
    if (r.ok) a.latency = a.latency ? Math.round(a.latency * 0.7 + ms * 0.3) : ms;
    return { status: r.status, body: j, ms };
  } finally {
    clearTimeout(timer);
  }
}

export function classify(res) {
  const b = res.body || {};
  const msg = String(b.error || b.message || '');
  if (res.status === 200 && !b.error) return { ok: true };
  if (res.status === 401) return { kind: 'auth', msg: msg || 'unauthorized' };
  if (res.status === 403 && (b.code === 'TIER_LOCKED_MODEL' || b.code === 'VIDEO_ACCESS_DENIED')) {
    return { kind: 'model', msg };
  }
  if (res.status === 429) return { kind: 'busy', msg: msg || 'concurrent' };
  if (res.status === 402 || /insufficient|not enough credit|no credits|balance is/i.test(msg)) {
    return { kind: 'credits', msg };
  }
  if (b.code === 'GENERATION_FAILED') return { kind: 'transient', msg };
  return { kind: 'error', msg: msg || 'upstream HTTP ' + res.status };
}

export function usable(a, model, excluded) {
  if (excluded.has(a.id)) return false;
  if (a.status !== 'active') return false;
  if (a.cooldownUntil && a.cooldownUntil > now()) return false;
  if (model && (a.blockedModels ?? []).includes(model)) return false;
  return true;
}

export function pick(model, excluded = new Set()) {
  const list = accounts.filter((a) => usable(a, model, excluded) && a.inFlight < config.perAccount);
  if (!list.length) return null;
  list.sort((x, y) => x.inFlight - y.inFlight || (x.lastUsed ?? 0) - (y.lastUsed ?? 0));
  return list[0];
}

export async function acquire(model, excluded, deadline) {
  for (;;) {
    const a = pick(model, excluded);
    if (a) {
      a.inFlight += 1;
      a.lastUsed = now();
      return a;
    }
    if (!accounts.some((x) => usable(x, model, excluded))) return null;
    if (now() > deadline) return null;
    await sleep(120);
  }
}

export function release(a) {
  if (a) a.inFlight = Math.max(0, a.inFlight - 1);
}

export async function resign(url, ttl = 7 * 24 * 3600) {
  try {
    const m = new URL(url).pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
    if (!m) return url;
    const a = accounts.filter((x) => x.status === 'active').sort((x, y) => (y.credits ?? 0) - (x.credits ?? 0))[0];
    if (!a) return url;
    const at = await ensureAT(a);
    const r = await fetch(config.supabaseUrl + '/storage/v1/object/sign/' + m[1] + '/' + m[2], {
      method: 'POST',
      headers: authHeaders(at),
      body: JSON.stringify({ expiresIn: ttl }),
    });
    const j = await r.json().catch(() => ({}));
    return j.signedURL ? config.supabaseUrl + '/storage/v1' + j.signedURL : url;
  } catch {
    return url;
  }
}

export async function uploadObject(buf, mime, ext) {
  const a = accounts.filter((x) => x.status === 'active').sort((x, y) => (y.credits ?? 0) - (x.credits ?? 0))[0];
  if (!a) throw new Error('no active account to upload with');
  const at = await ensureAT(a);
  const key = (a.user_id ?? 'anon') + '/uploads/' + uuid() + ext;
  const r = await fetch(config.supabaseUrl + '/storage/v1/object/' + config.bucket + '/' + key, {
    method: 'POST',
    headers: { apikey: config.anon, Authorization: 'Bearer ' + at, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buf,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('upload failed HTTP ' + r.status + ' ' + t.slice(0, 120));
  }
  const signed = await fetch(config.supabaseUrl + '/storage/v1/object/sign/' + config.bucket + '/' + key, {
    method: 'POST',
    headers: { apikey: config.anon, 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
    body: JSON.stringify({ expiresIn: 24 * 3600 }),
  })
    .then((x) => x.json())
    .catch(() => null);
  if (!signed?.signedURL) throw new Error('sign after upload failed');
  return { url: config.supabaseUrl + '/storage/v1' + signed.signedURL, path: key };
}

export function startKeepalive() {
  const tick = setInterval(async () => {
    for (const a of accounts) {
      if (a.status !== 'active') continue;
      if (a.exp && a.exp - now() > config.refreshWindowMs) continue;
      try {
        await refreshAccount(a);
      } catch {
        /* keepalive failure is non-fatal */
      }
    }
  }, config.keepaliveMs);
  if (tick.unref) tick.unref();
  return tick;
}

export async function removeAccount(id) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  accounts.splice(i, 1);
  await flushAccounts();
  return true;
}
