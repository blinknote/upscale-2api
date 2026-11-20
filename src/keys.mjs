import crypto from 'node:crypto';
import { config, paths } from './config.mjs';
import { atomicWriteJson, debounce, mask, now, randomToken, readJson, sha256, uuid } from './util.mjs';

const PREFIX = 'sk-ups-';

export const keys = [];
const byHash = new Map();
const buckets = new Map();
let dirty = false;

const persist = debounce(async () => {
  await atomicWriteJson(paths.keys, {
    version: 1,
    updatedAt: new Date().toISOString(),
    keys,
  });
}, 60);

function index(k) {
  byHash.set(k.hash, k);
}

export function saveKeys() {
  dirty = true;
  persist();
}

export async function flushKeys() {
  await persist.flush();
}

function makeKey() {
  return PREFIX + randomToken(30);
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export async function loadKeys() {
  const j = await readJson(paths.keys, { keys: [] });
  keys.length = 0;
  byHash.clear();
  for (const k of j.keys ?? []) {
    keys.push({
      id: k.id ?? 'key_' + uuid().slice(0, 8),
      name: k.name ?? 'client',
      hash: k.hash,
      prefix: k.prefix ?? null,
      enabled: k.enabled !== false,
      created_at: k.created_at ?? new Date().toISOString(),
      expires_at: k.expires_at ?? null,
      rpm: k.rpm ?? 60,
      credits_quota: k.credits_quota ?? null,
      credits_used: k.credits_used ?? 0,
      daily_requests: k.daily_requests ?? null,
      models: k.models ?? [],
      note: k.note ?? '',
      usage: { requests: 0, images: 0, failed: 0, day: dayKey(), day_count: 0, ...(k.usage ?? {}) },
      last_used_at: k.last_used_at ?? null,
      last_ip: k.last_ip ?? null,
    });
    index(keys[keys.length - 1]);
  }
  if (!keys.length && config.bootstrapKeys.length) {
    for (const raw of config.bootstrapKeys) {
      keys.push(blankKey(raw, 'bootstrap', {}));
      index(keys[keys.length - 1]);
    }
    saveKeys();
  }
}

function blankKey(raw, name, opts) {
  return {
    id: 'key_' + uuid().slice(0, 8),
    name,
    hash: sha256(raw),
    prefix: raw.slice(0, 12) + '…',
    enabled: true,
    created_at: new Date().toISOString(),
    expires_at: opts.expires_at ?? null,
    rpm: opts.rpm ?? 60,
    credits_quota: opts.credits_quota ?? null,
    credits_used: 0,
    daily_requests: opts.daily_requests ?? null,
    models: opts.models ?? [],
    note: opts.note ?? '',
    usage: { requests: 0, images: 0, failed: 0, day: dayKey(), day_count: 0 },
    last_used_at: null,
    last_ip: null,
  };
}

export function createKey({ name, rpm, credits_quota, daily_requests, expires_days, models, note }) {
  const raw = makeKey();
  const expires_at = expires_days ? new Date(now() + Number(expires_days) * 86400000).toISOString() : null;
  const k = blankKey(raw, name || 'client', {
    rpm: Number(rpm) > 0 ? Number(rpm) : 60,
    credits_quota: credits_quota == null || credits_quota === '' ? null : Number(credits_quota),
    daily_requests: daily_requests == null || daily_requests === '' ? null : Number(daily_requests),
    expires_at,
    models: Array.isArray(models) ? models : [],
    note: note ?? '',
  });
  keys.push(k);
  index(k);
  saveKeys();
  return { key: raw, meta: pubKey(k) };
}

export function pubKey(k) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    enabled: k.enabled,
    created_at: k.created_at,
    expires_at: k.expires_at,
    rpm: k.rpm,
    credits_quota: k.credits_quota,
    credits_used: k.credits_used,
    credits_left: k.credits_quota == null ? null : Math.max(0, k.credits_quota - k.credits_used),
    daily_requests: k.daily_requests,
    models: k.models,
    note: k.note,
    usage: k.usage,
    last_used_at: k.last_used_at,
    last_ip: k.last_ip,
  };
}

export function listKeys() {
  return keys.map(pubKey);
}

export function updateKey(id, patch) {
  const k = keys.find((x) => x.id === id);
  if (!k) return null;
  for (const f of ['name', 'enabled', 'rpm', 'credits_quota', 'daily_requests', 'note', 'models', 'expires_at']) {
    if (patch[f] !== undefined) k[f] = patch[f];
  }
  if (patch.credits_reset) k.credits_used = 0;
  saveKeys();
  return pubKey(k);
}

export function deleteKey(id) {
  const i = keys.findIndex((x) => x.id === id);
  if (i < 0) return false;
  byHash.delete(keys[i].hash);
  keys.splice(i, 1);
  saveKeys();
  return true;
}

export function rotateKey(id) {
  const k = keys.find((x) => x.id === id);
  if (!k) return null;
  const raw = makeKey();
  byHash.delete(k.hash);
  k.hash = sha256(raw);
  k.prefix = raw.slice(0, 12) + '…';
  index(k);
  saveKeys();
  return { key: raw, meta: pubKey(k) };
}

function rateOk(k, perMinute) {
  const t = now();
  const arr = (buckets.get(k.id) ?? []).filter((x) => t - x < 60000);
  if (arr.length >= perMinute) {
    buckets.set(k.id, arr);
    return Math.ceil((60000 - (t - arr[0])) / 1000);
  }
  arr.push(t);
  buckets.set(k.id, arr);
  return 0;
}

export function verifyKey(raw) {
  if (!raw) return { error: 'missing api key', status: 401, code: 'missing_api_key' };
  const k = byHash.get(sha256(raw));
  if (!k) return { error: 'invalid api key', status: 401, code: 'invalid_api_key' };
  if (!k.enabled) return { error: 'api key disabled', status: 403, code: 'key_disabled', key: k };
  if (k.expires_at && new Date(k.expires_at).getTime() < now()) {
    return { error: 'api key expired', status: 403, code: 'key_expired', key: k };
  }
  const today = dayKey();
  if (k.usage.day !== today) {
    k.usage.day = today;
    k.usage.day_count = 0;
  }
  if (k.daily_requests != null && k.usage.day_count >= k.daily_requests) {
    return { error: 'daily request quota exhausted', status: 429, code: 'daily_quota_exceeded', key: k };
  }
  if (k.credits_quota != null && k.credits_used >= k.credits_quota) {
    return { error: 'credit quota exhausted', status: 402, code: 'quota_exhausted', key: k };
  }
  const wait = rateOk(k, k.rpm);
  if (wait) {
    return { error: 'rate limit exceeded, retry in ' + wait + 's', status: 429, code: 'rate_limited', key: k, retryAfter: wait };
  }
  return { key: k };
}

export function touchKey(k, { credits = 0, images = 0, failed = 0, ip = null }) {
  if (!k) return;
  k.usage.requests += 1;
  k.usage.day_count += 1;
  k.usage.images += images;
  k.usage.failed += failed;
  k.credits_used += credits;
  k.last_used_at = new Date().toISOString();
  if (ip) k.last_ip = ip;
  saveKeys();
}

export function keyAllowsModel(k, modelId) {
  if (!k || !k.models?.length) return true;
  return k.models.includes(modelId);
}
