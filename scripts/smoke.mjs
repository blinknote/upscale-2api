#!/usr/bin/env node
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_KEY ?? 'admin';

let pass = 0;
let fail = 0;
const created = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (extra ? '  ' + extra : ''));
  }
}

async function call(path, { method = 'GET', key, admin, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.authorization = 'Bearer ' + key;
  if (admin) h['x-admin-key'] = ADMIN;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* stream or plain */
  }
  return { status: r.status, json, text, headers: r.headers };
}

async function adminKey(payload) {
  const r = await call('/admin/api/keys', { method: 'POST', admin: true, body: payload });
  if (r.status !== 200) throw new Error('create key failed: ' + r.text.slice(0, 200));
  const k = r.json.created[0];
  created.push(k.meta.id);
  return k;
}

console.log('smoke -> ' + BASE);

const health = await call('/healthz');
ok('GET /healthz', health.status === 200 && health.json?.ok === true);

const ready = await call('/readyz');
ok('GET /readyz', ready.status === 200 || ready.status === 503, 'status=' + ready.status);

const noAuth = await call('/v1/models');
ok('GET /v1/models 无 key -> 401', noAuth.status === 401 && noAuth.json?.error?.code === 'missing_api_key');

const badAuth = await call('/v1/models', { key: 'sk-nope' });
ok('GET /v1/models 错 key -> 401', badAuth.status === 401);

const full = await adminKey({ name: 'smoke-full', rpm: 240 });
const models = await call('/v1/models', { key: full.key });
ok('GET /v1/models 列表', models.status === 200 && models.json.object === 'list' && models.json.data.length >= 21, 'n=' + models.json?.data?.length);

const one = await call('/v1/models/nano-banana-pro', { key: full.key });
ok('GET /v1/models/:id', one.status === 200 && one.json.id === 'nano-banana-pro');

const aliasModel = await call('/v1/models/dall-e-3', { key: full.key });
ok('GET /v1/models 别名可查', aliasModel.status === 200 && aliasModel.json.alias_of === 'nano-banana-pro');

const missing = await call('/v1/models/nope-model', { key: full.key });
ok('GET /v1/models 不存在 -> 404', missing.status === 404);

const limited = await adminKey({ name: 'smoke-rpm', rpm: 2 });
await call('/v1/models', { key: limited.key });
await call('/v1/models', { key: limited.key });
const third = await call('/v1/models', { key: limited.key });
ok('RPM 限流 -> 429', third.status === 429 && third.json?.error?.code === 'rate_limited');

const zeroQuota = await adminKey({ name: 'smoke-quota', credits_quota: 0 });
const quotaHit = await call('/v1/models', { key: zeroQuota.key });
ok('额度耗尽 -> 402', quotaHit.status === 402 && quotaHit.json?.error?.code === 'quota_exhausted');

const gated = await adminKey({ name: 'smoke-gated', models: ['z-image-turbo'] });
const denied = await call('/v1/images/generations', { method: 'POST', key: gated.key, body: { prompt: 'x', model: 'nano-banana-pro' } });
ok('模型白名单 -> 403', denied.status === 403 && denied.json?.error?.code === 'model_forbidden');

const unknown = await call('/v1/images/generations', { method: 'POST', key: full.key, body: { prompt: 'x', model: 'not-a-model' } });
ok('未知模型 -> 404', unknown.status === 404 && unknown.json?.error?.code === 'model_not_found');

const noPrompt = await call('/v1/images/generations', { method: 'POST', key: full.key, body: {} });
ok('缺 prompt -> 400', noPrompt.status === 400);

const disabledKey = await adminKey({ name: 'smoke-disable' });
await call('/admin/api/keys/' + disabledKey.meta.id, { method: 'PATCH', admin: true, body: { enabled: false } });
const disabled = await call('/v1/models', { key: disabledKey.key });
ok('停用 key -> 403', disabled.status === 403 && disabled.json?.error?.code === 'key_disabled');

const rotated = await call('/admin/api/keys/' + full.meta.id + '/rotate', { method: 'POST', admin: true });
ok('换发密钥', rotated.status === 200 && rotated.json.key && rotated.json.key !== full.key);
const oldKeyGone = await call('/v1/models', { key: full.key });
ok('旧密钥失效 -> 401', oldKeyGone.status === 401);
full.key = rotated.json.key;

if (ready.status === 200) {
  const gen = await call('/v1/images/generations', {
    method: 'POST',
    key: full.key,
    body: { prompt: 'matte ceramic cup on linen, soft window light', model: 'z-image-turbo', size: '1024x1024', n: 1 },
  });
  const url = gen.json?.data?.[0]?.url;
  ok('POST /v1/images/generations', gen.status === 200 && !!url, url ? url.replace(BASE, '') : gen.text.slice(0, 120));
  if (url) {
    const abs = url.startsWith('http') ? url : BASE + url;
    const f = await fetch(abs);
    ok('产物可下载', f.status === 200 && (f.headers.get('content-type') || '').startsWith('image/'));
  }

  const chat = await call('/v1/chat/completions', {
    method: 'POST',
    key: full.key,
    body: { model: 'flux-schnell', messages: [{ role: 'user', content: '/imagine an old wooden door' }], stream: true },
  });
  ok('chat 流式', chat.status === 200 && chat.text.includes('data: [DONE]') && chat.text.includes('chat.completion.chunk'));

  const up = await call('/v1/upscale', {
    method: 'POST',
    key: full.key,
    body: { image_url: 'https://upscaleaistudio.com/assets/upscale-thumb-Dd9vZYFY.jpg', factor: 2, engine: 'upscale-image' },
  });
  ok('POST /v1/upscale', up.status === 200 && !!up.json?.data?.[0]?.url);

  const enhance = await call('/v1/enhance', { method: 'POST', key: full.key, body: { prompt: 'a yacht' } });
  ok('POST /v1/enhance', enhance.status === 200 && typeof enhance.json?.enhanced === 'string');

  const usage = await call('/v1/usage', { key: full.key });
  ok('GET /v1/usage', usage.status === 200 && usage.json.requests >= 1 && usage.json.credits_used >= 2, 'credits=' + usage.json?.credits_used);

  const billing = await call('/v1/dashboard/billing/credit_grants', { key: full.key });
  ok('GET billing/credit_grants', billing.status === 200 && billing.json.object === 'credit_summary');

  const resp = await call('/v1/responses', { method: 'POST', key: full.key, body: { model: 'z-image-turbo', input: 'a cactus in a blue pot' } });
  ok('POST /v1/responses', resp.status === 200 && resp.json.output_text?.includes('![generated]'));
} else {
  console.log('  SKIP  生成类用例（无可用上游账号）');
}

for (const id of created) await call('/admin/api/keys/' + id, { method: 'DELETE', admin: true });

const stats = await call('/admin/api/stats', { admin: true });
ok('GET /admin/api/stats', stats.status === 200 && stats.json.pool);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
