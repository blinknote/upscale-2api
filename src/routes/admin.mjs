import fs from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC, config, paths } from '../config.mjs';
import { cleanupRetention, fileStats, listFiles, persistBuffer } from '../files.mjs';
import { json, readJson, readMultipart, send } from '../http.mjs';
import {
  accounts,
  fetchAccountInfo,
  flushAccounts,
  nextAccountId,
  passwordLogin,
  pubAccount,
  refreshAccount,
  saveAccounts,
  signup,
} from '../session.mjs';
import { createKey, deleteKey, flushKeys, keyAllowsModel, listKeys, rotateKey, updateKey } from '../keys.mjs';
import { ALIASES, IMAGE_MODELS, UPSCALE_ENGINES } from '../models.mjs';
import { jwtInfo, mask, now, sleep, uuid } from '../util.mjs';
import { logs } from '../logs.mjs';

const K_RT = ['refresh', 'token'].join('_');
const K_AT = ['access', 'token'].join('_');

function adminOk(req) {
  const given = String(req.headers['x-admin-key'] ?? req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
  return given && given === config.adminKey;
}

const normKey = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

function pickKey(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const ks = Object.keys(obj);
  for (const n of names) {
    const hit = ks.find((k) => normKey(k) === n);
    if (hit) return hit;
  }
  return null;
}

export function parseSeed(input) {
  if (input == null) return null;
  if (Array.isArray(input)) return input.map(parseSeed).filter(Boolean).flat();
  if (typeof input === 'object') {
    const pk = pickKey(input, ['password', 'pwd', 'pass']);
    const ek = pickKey(input, ['email', 'mail', 'username']);
    if (ek && pk) return { email: input[ek], pass: input[pk] };
    const rtk = pickKey(input, ['refreshtoken', 'rt']);
    const atk = pickKey(input, ['accesstoken', 'at']);
    if (rtk) {
      const uid = (input.user && input.user.id) ||input.userid || input.id || null;
      return { rt: input[rtk], at: atk ? input[atk] : null, uid };
    }
    for (const v of Object.values(input)) {
      if (v && typeof v === 'object') {
        const r = parseSeed(v);
        if (r) return r;
      }
    }
    return null;
  }
  const s = String(input).trim();
  if (!s) return null;
  if (s[0] === '{' || s[0] === '[') {
    try {
      return parseSeed(JSON.parse(s));
    } catch {
      return null;
    }
  }
  if (s.includes('@') && s.includes(':')) {
    const i = s.lastIndexOf(':');
    return { email: s.slice(0, i), pass: s.slice(i + 1) };
  }
  return { rt: s };
}

async function buildAccount(seed, name) {
  if (!seed) throw new Error('cannot parse input');
  let rt = seed.rt;
  let at = seed.at ?? null;
  let uid = seed.uid ?? null;
  let email = seed.email ?? null;
  if (seed.email && seed.pass) {
    const j = await passwordLogin(seed.email, seed.pass);
    rt = j[K_RT];
    at = j[K_AT];
    uid = jwtInfo(at).sub;
  }
  if (!rt) throw new Error('no refresh token resolved');
  const dup = accounts.find((a) => a.rt === rt);
  if (dup) return { account: pubAccount(dup), duplicate: true };
  const a = {
    id: nextAccountId(),
    name: name || email || (uid ? 'acct-' + String(uid).slice(0, 8) : 'acct'),
    rt,
    at,
    exp: at ? jwtInfo(at).exp : 0,
    user_id: uid,
    email,
    tier: null,
    credits: null,
    status: 'active',
    cooldownUntil: 0,
    blockedModels: [],
    lastError: null,
    lastUsed: 0,
    inFlight: 0,
    stats: { ok: 0, fail: 0 },
    latency: null,
    createdAt: new Date().toISOString(),
  };
  accounts.push(a);
  try {
    await fetchAccountInfo(a);
  } catch (e) {
    a.lastError = String(e?.message ?? e);
    if (!a.at) a.status = 'invalid';
  }
  await flushAccounts();
  return { account: pubAccount(a) };
}

function poolStats() {
  const active = accounts.filter((a) => a.status === 'active' && !(a.cooldownUntil > now()));
  const credits = accounts.reduce((s, a) => s + (a.credits ?? 0), 0);
  return {
    accounts: accounts.length,
    active: active.length,
    invalid: accounts.filter((a) => a.status === 'invalid').length,
    in_flight: accounts.reduce((s, a) => s + a.inFlight, 0),
    credits_total: credits,
    ok: accounts.reduce((s, a) => s + (a.stats?.ok ?? 0), 0),
    fail: accounts.reduce((s, a) => s + (a.stats?.fail ?? 0), 0),
    latency_ms: active.length ? Math.round(active.reduce((s, a) => s + (a.latency ?? 0), 0) / active.length) : null,
  };
}

async function servePanel(res) {
  try {
    const html = await fs.readFile(path.join(PUBLIC, 'admin.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e) {
    send(res, 500, 'panel missing: ' + e.message);
  }
}

export async function handle(req, res, p, url) {
  if (p === '/admin' || p === '/admin/') {
    await servePanel(res);
    return true;
  }
  if (!p.startsWith('/admin/api/')) return false;
  if (!adminOk(req)) {
    json(res, 401, { error: 'bad admin key' });
    return true;
  }
  const seg = p.slice('/admin/api/'.length).split('/');

  if (p === '/admin/api/stats' && req.method === 'GET') {
    const ks = listKeys();
    json(res, 200, {
      pool: poolStats(),
      keys: {
        total: ks.length,
        enabled: ks.filter((k) => k.enabled).length,
        requests: ks.reduce((s, k) => s + k.usage.requests, 0),
        credits_used: ks.reduce((s, k) => s + k.credits_used, 0),
      },
      files: fileStats(),
      models: IMAGE_MODELS.length,
      uptime_s: Math.round(process.uptime()),
      version: '1.0.0',
    });
    return true;
  }

  if (p === '/admin/api/accounts' && req.method === 'GET') {
    json(res, 200, { accounts: accounts.map(pubAccount), count: accounts.length });
    return true;
  }

  if (p === '/admin/api/accounts' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.signup) {
      if (!b.email || !b.password) return json(res, 400, { error: 'email and password required for signup' }), true;
      try {
        const j = await signup(b.email, b.password, b.name);
        const at = j[K_AT];
        const r = await buildAccount({ rt: j[K_RT], at, uid: jwtInfo(at).sub, email: b.email }, b.name);
        r.signed_up = true;
        return json(res, 200, { results: [r] }), true;
      } catch (e) {
        return json(res, 400, { error: String(e.message ?? e) }), true;
      }
    }
    const input = b.input ?? b.rt ?? b.text ?? b;
    const seeds = [].concat(parseSeed(input) ?? []);
    const results = [];
    for (const s of seeds) {
      try {
        results.push(await buildAccount(s, b.name));
      } catch (e) {
        results.push({ error: String(e.message ?? e) });
      }
    }
    if (!results.length) return json(res, 400, { error: 'cannot parse input' }), true;
    json(res, 200, { results });
    return true;
  }

  if (seg[0] === 'accounts' && seg[1] && req.method === 'DELETE') {
    const i = accounts.findIndex((a) => a.id === seg[1]);
    if (i < 0) return json(res, 404, { error: 'no such account' }), true;
    accounts.splice(i, 1);
    await flushAccounts();
    json(res, 200, { ok: true });
    return true;
  }

  if (seg[0] === 'accounts' && seg[1] && seg[2] === 'refresh' && req.method === 'POST') {
    const a = accounts.find((x) => x.id === seg[1]);
    if (!a) return json(res, 404, { error: 'no such account' }), true;
    try {
      a.status = 'active';
      a.cooldownUntil = 0;
      a.blockedModels = [];
      await refreshAccount(a);
      const info = await fetchAccountInfo(a);
      json(res, 200, { account: pubAccount(a), info });
    } catch (e) {
      json(res, 400, { error: String(e.message ?? e), account: pubAccount(a) });
    }
    return true;
  }

  if (seg[0] === 'accounts' && seg[1] && seg[2] === 'purge' && req.method === 'POST') {
    const a = accounts.find((x) => x.id === seg[1]);
    if (!a) return json(res, 404, { error: 'no such account' }), true;
    const { callFn } = await import('../session.mjs');
    const r = await callFn(a, 'delete-account', { mode: 'account' }).catch((e) => ({ status: 0, body: { error: String(e.message) } }));
    json(res, 200, { upstream: { status: r.status, body: r.body } });
    return true;
  }

  if (p === '/admin/api/keys' && req.method === 'GET') {
    json(res, 200, { keys: listKeys() });
    return true;
  }

  if (p === '/admin/api/keys' && req.method === 'POST') {
    const b = await readJson(req);
    const count = Math.max(1, Math.min(Number(b.count) || 1, 50));
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(createKey({ ...b, name: count > 1 ? (b.name || 'client') + '-' + (i + 1) : b.name }));
    }
    await flushKeys();
    json(res, 200, { created });
    return true;
  }

  if (seg[0] === 'keys' && seg[1] && req.method === 'PATCH') {
    const b = await readJson(req);
    const k = updateKey(seg[1], b);
    if (!k) return json(res, 404, { error: 'no such key' }), true;
    await flushKeys();
    json(res, 200, { key: k });
    return true;
  }

  if (seg[0] === 'keys' && seg[1] && req.method === 'DELETE') {
    const ok = deleteKey(seg[1]);
    await flushKeys();
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such key' });
    return true;
  }

  if (seg[0] === 'keys' && seg[1] && seg[2] === 'rotate' && req.method === 'POST') {
    const r = rotateKey(seg[1]);
    if (!r) return json(res, 404, { error: 'no such key' }), true;
    await flushKeys();
    json(res, 200, r);
    return true;
  }

  if (p === '/admin/api/logs' && req.method === 'GET') {
    json(res, 200, { logs: logs.list(Number(url.searchParams.get('n') ?? 100)) });
    return true;
  }

  if (p === '/admin/api/models' && req.method === 'GET') {
    json(res, 200, {
      image: IMAGE_MODELS,
      aliases: ALIASES,
      upscale: Object.entries(UPSCALE_ENGINES).map(([id, v]) => ({ id, ...v })),
    });
    return true;
  }

  if (p === '/admin/api/files' && req.method === 'GET') {
    json(res, 200, { files: listFiles(Number(url.searchParams.get('n') ?? 100)), stats: fileStats() });
    return true;
  }

  if (p === '/admin/api/files/cleanup' && req.method === 'POST') {
    json(res, 200, await cleanupRetention());
    return true;
  }

  if (p === '/admin/api/files/upload' && req.method === 'POST') {
    const { files } = await readMultipart(req);
    const f = files[0];
    if (!f) return json(res, 400, { error: 'no file' }), true;
    const ext = f.mime === 'image/jpeg' ? '.jpg' : f.mime === 'image/webp' ? '.webp' : '.png';
    const local = await persistBuffer(f.data, ext);
    json(res, 200, { url: local, bytes: f.data.length });
    return true;
  }

  if (p === '/admin/api/config' && req.method === 'GET') {
    json(res, 200, {
      port: config.port,
      host: config.host,
      public_base_url: config.publicBase || null,
      per_account_concurrency: config.perAccount,
      queue_wait_ms: config.queueWaitMs,
      default_model: config.defaultModel,
      retention_days: config.retentionDays,
      upstream: config.supabaseUrl,
      anon_key: mask(config.anon, 8, 6),
    });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
