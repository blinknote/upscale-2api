import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.mjs';
import { persist } from '../files.mjs';
import { absBase, bearerOf, clientIp, json, oaiError, readJson, readMultipart } from '../http.mjs';
import { keyAllowsModel, touchKey, verifyKey } from '../keys.mjs';
import { ALIASES, IMAGE_MODELS, MODEL_BY_ID, UPSCALE_ENGINES, creditsFor, resolveModel, sizeToAspect } from '../models.mjs';
import { runPooled } from '../pool.mjs';
import { accounts, uploadObject } from '../session.mjs';

const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function requireKey(req, res) {
  const raw = bearerOf(req);
  const v = verifyKey(raw);
  if (v.error) {
    const headers = {};
    if (v.retryAfter) headers['retry-after'] = String(v.retryAfter);
    oaiError(res, v.status, v.error, { code: v.code, type: 'authentication_error', headers });
    return null;
  }
  return v.key;
}

export function modelObject(m) {
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'upscaleai',
    root: m.id,
    parent: null,
    permission: [],
    credits: m.credits,
    group: m.group,
    capabilities: ['image'],
  };
}

export function allModels() {
  const list = IMAGE_MODELS.map(modelObject);
  for (const [alias, target] of Object.entries(ALIASES)) {
    const m = MODEL_BY_ID.get(target);
    list.push({ ...modelObject({ ...m, id: alias }), alias_of: target });
  }
  return list;
}

function dataUrlToBuffer(s) {
  const m = String(s).match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

async function resolveReference(ref) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.url) return ref.url;
  const s = String(ref);
  const parsed = dataUrlToBuffer(s);
  if (parsed) {
    const up = await uploadObject(parsed.buf, parsed.mime, EXT_BY_MIME[parsed.mime] ?? '.png');
    return up.url;
  }
  return s;
}

async function readAny(req) {
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('multipart/form-data')) {
    const { fields, files } = await readMultipart(req);
    let uploaded = null;
    const f = files.find((x) => x.field === 'image' || x.field === 'image[]') ?? files[0];
    if (f) {
      const up = await uploadObject(f.data, f.mime, EXT_BY_MIME[f.mime] ?? '.png');
      uploaded = up.url;
    }
    return { body: fields, uploaded };
  }
  return { body: await readJson(req), uploaded: null };
}

async function doGenerate(req, res, key, { edits = false } = {}) {
  const started = Date.now();
  let body;
  let uploaded;
  try {
    ({ body, uploaded } = await readAny(req));
  } catch (e) {
    return oaiError(res, e.status ?? 400, String(e.message ?? e));
  }

  const prompt = String(body.prompt ?? body.input ?? '').trim();
  if (!prompt) return oaiError(res, 400, 'prompt is required', { param: 'prompt' });

  const requested = resolveModel(body.model);
  if (body.model && !requested) {
    return oaiError(res, 404, 'unknown model: ' + body.model, { code: 'model_not_found', param: 'model', type: 'invalid_request_error' });
  }
  const model = requested ?? resolveModel(config.defaultModel) ?? 'nano-banana';
  if (!keyAllowsModel(key, model)) {
    return oaiError(res, 403, 'api key is not allowed to use model ' + model, { code: 'model_forbidden' });
  }

  const n = Math.max(1, Math.min(Number(body.n) || 1, 4));
  const aspect = sizeToAspect(body.size ?? body.aspect_ratio ?? body.aspectRatio);
  const quality = String(body.quality ?? 'high');
  const wantB64 = String(body.response_format ?? 'url') === 'b64_json';
  const reference = uploaded ?? (await resolveReference(body.image ?? body.image_url ?? body.reference_image_url ?? (Array.isArray(body.referenceImages) ? body.referenceImages[0] : null)));

  const upstream = {
    prompt,
    model,
    aspectRatio: aspect,
    quality: quality === 'low' ? 'standard' : quality,
    numOutputs: n,
  };
  if (body.negative_prompt) upstream.negativePrompt = String(body.negative_prompt);
  if (reference) {
    upstream.referenceImageUrl = reference;
    upstream.referenceImageUrls = [reference];
  }
  if (edits && !reference) return oaiError(res, 400, 'image is required for edits', { param: 'image' });

  const cost = creditsFor(model, n);
  const out = await runPooled('generate-image', upstream, { model, cost, timeoutMs: 300000 });
  if (!out.ok) {
    touchKey(key, { failed: 1, ip: clientIp(req) });
    return oaiError(res, out.code === 'no_accounts' ? 503 : 502, out.message, { code: 'upstream_error', type: 'upstream_error' });
  }

  const assets = out.data.assets ?? [];
  const base = absBase(req);
  const data = [];
  for (const a of assets) {
    const saved = await persist(a.url, { source: 'generation' });
    if (wantB64 && saved.local) {
      const buf = await fs.readFile(path.join(paths.files, path.basename(saved.local)));
      data.push({ b64_json: buf.toString('base64'), revised_prompt: prompt });
    } else {
      data.push({ url: saved.local ? base + saved.local : a.url, revised_prompt: prompt });
    }
  }
  if (!data.length) {
    touchKey(key, { failed: 1, ip: clientIp(req) });
    return oaiError(res, 502, 'upstream returned no assets', { code: 'empty_result', type: 'upstream_error' });
  }

  touchKey(key, { credits: cost, images: data.length, ip: clientIp(req) });
  return json(
    res,
    200,
    {
      created: Math.floor(Date.now() / 1000),
      data,
      model,
      usage: { credits: cost, images: data.length },
      elapsed_ms: Date.now() - started,
      account: out.account.name,
    },
    { 'x-credits-used': String(cost) }
  );
}

function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const users = arr.filter((m) => m && m.role === 'user');
  const pickText = (m) => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((c) => c && (c.type === 'text' || c.type === 'input_text')).map((c) => c.text ?? '').join(' ');
    }
    return '';
  };
  const target = users.length ? users[users.length - 1] : arr[arr.length - 1];
  return String(pickText(target ?? {}) || '').trim();
}

function collectImages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content) {
      const url = c?.image_url?.url ?? c?.image_url ?? (c?.type === 'input_image' ? c.image_url : null);
      if (url && typeof url === 'string') out.push(url);
    }
  }
  return out;
}

async function renderForChat(b, key, req) {
  const prompt0 = lastUserText(b.messages) || String(b.prompt ?? '');
  const prompt = prompt0.replace(/^\s*\/(imagine|image|draw|gen)\s*/i, '').trim();
  if (!prompt) throw Object.assign(new Error('no user prompt in messages'), { status: 400 });
  const model = resolveModel(b.model) ?? resolveModel(config.defaultModel) ?? 'nano-banana';
  if (!keyAllowsModel(key, model)) throw Object.assign(new Error('model not allowed for this key'), { status: 403 });
  const images = collectImages(b.messages);
  let reference = null;
  if (images.length) reference = await resolveReference(images[0]);
  const upstream = {
    prompt,
    model,
    aspectRatio: sizeToAspect(b.size ?? b.aspect_ratio),
    quality: String(b.quality ?? 'high'),
    numOutputs: 1,
  };
  if (reference) {
    upstream.referenceImageUrl = reference;
    upstream.referenceImageUrls = [reference];
  }
  const cost = creditsFor(model, 1);
  const out = await runPooled('generate-image', upstream, { model, cost, timeoutMs: 300000 });
  if (!out.ok) {
    touchKey(key, { failed: 1, ip: clientIp(req) });
    throw Object.assign(new Error(out.message), { status: 502, credits: 0 });
  }
  const asset = (out.data.assets ?? [])[0];
  if (!asset) throw Object.assign(new Error('upstream returned no assets'), { status: 502 });
  const saved = await persist(asset.url, { source: 'chat' });
  const url = saved.local ? absBase(req) + saved.local : asset.url;
  touchKey(key, { credits: cost, images: 1, ip: clientIp(req) });
  return { text: '![generated](' + url + ')', model, url, cost };
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
}

export async function handle(req, res, p, url) {
  if (!p.startsWith('/v1/')) return false;

  const key = requireKey(req, res);
  if (!key) return true;

  if (p === '/v1/models' && req.method === 'GET') {
    json(res, 200, { object: 'list', data: allModels() });
    return true;
  }

  const mm = p.match(/^\/v1\/models\/(.+)$/);
  if (mm && req.method === 'GET') {
    const id = decodeURIComponent(mm[1]);
    const hit = allModels().find((m) => m.id === id);
    if (!hit) return oaiError(res, 404, 'model not found: ' + id, { code: 'model_not_found' }), true;
    json(res, 200, hit);
    return true;
  }

  if ((p === '/v1/images/generations' && req.method === 'POST')) {
    await doGenerate(req, res, key);
    return true;
  }
  if ((p === '/v1/images/edits' && req.method === 'POST')) {
    await doGenerate(req, res, key, { edits: true });
    return true;
  }

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    const b = await readJson(req);
    let out;
    try {
      out = await renderForChat(b, key, req);
    } catch (e) {
      return oaiError(res, e.status ?? 500, String(e.message ?? e), { type: 'upstream_error' }), true;
    }
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);
    if (b.stream) {
      sseHead(res);
      const base = { id, object: 'chat.completion.chunk', created, model: out.model };
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: out.text }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      if (b.stream_options?.include_usage) {
        res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      return res.end(), true;
    }
    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: out.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, credits: out.cost },
    });
    return true;
  }

  if (p === '/v1/responses' && req.method === 'POST') {
    const b = await readJson(req);
    const messages = Array.isArray(b.input)
      ? b.input
      : [{ role: 'user', content: String(b.input ?? b.prompt ?? '') }];
    let out;
    try {
      out = await renderForChat({ ...b, messages }, key, req);
    } catch (e) {
      return oaiError(res, e.status ?? 500, String(e.message ?? e), { type: 'upstream_error' }), true;
    }
    json(res, 200, {
      id: 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: out.model,
      status: 'completed',
      output: [
        {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: out.text, annotations: [] }],
        },
      ],
      output_text: out.text,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    return true;
  }

  if (p === '/v1/upscale' && req.method === 'POST') {
    const { body, uploaded } = await readAny(req);
    const img = uploaded ?? body.image_url ?? body.image;
    if (!img) return oaiError(res, 400, 'image_url is required', { param: 'image_url' }), true;
    const engine = String(body.engine ?? 'upscale-image');
    if (!UPSCALE_ENGINES[engine]) return oaiError(res, 404, 'unknown upscale engine: ' + engine, { code: 'engine_not_found' }), true;
    const source = await resolveReference(img);
    const up = {
      imageUrl: source,
      factor: Number(body.factor ?? 2),
      upscaleFactor: Number(body.factor ?? 2),
      removeBackground: !!body.remove_background,
      outputFormat: String(body.format ?? 'png'),
      upscaleMode: body.mode ?? 'balanced',
      faceEnhancement: body.face_enhancement !== false,
      enhanceDetails: body.enhance_details !== false,
      enhanceRealism: body.enhance_realism !== false,
    };
    const out = await runPooled(engine, up, { cost: UPSCALE_ENGINES[engine].credits, timeoutMs: 300000 });
    if (!out.ok) {
      touchKey(key, { failed: 1, ip: clientIp(req) });
      return oaiError(res, 502, out.message, { code: 'upstream_error', type: 'upstream_error' }), true;
    }
    const dest = out.data?.url ?? out.data?.image_url;
    const saved = await persist(dest, { source: 'upscale' });
    touchKey(key, { credits: UPSCALE_ENGINES[engine].credits, images: 1, ip: clientIp(req) });
    json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: saved.local ? absBase(req) + saved.local : dest }],
      engine,
      source,
      usage: { credits: UPSCALE_ENGINES[engine].credits },
    });
    return true;
  }

  if (p === '/v1/enhance' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b.prompt) return oaiError(res, 400, 'prompt is required', { param: 'prompt' }), true;
    const out = await runPooled('enhance-prompt', { prompt: String(b.prompt) }, {});
    if (!out.ok) return oaiError(res, 502, out.message, { type: 'upstream_error' }), true;
    json(res, 200, out.data);
    return true;
  }

  if (p.startsWith('/v1/raw/') && req.method === 'POST') {
    const fn = p.slice('/v1/raw/'.length);
    const b = await readJson(req);
    const out = await runPooled(fn, b, { cost: Number(b.__cost ?? 0) || 0 });
    if (!out.ok) return oaiError(res, 502, out.message, { type: 'upstream_error' }), true;
    json(res, 200, out.data);
    return true;
  }

  if (p === '/v1/credits' && req.method === 'GET') {
    json(res, 200, {
      object: 'credits',
      upstream_balance: accounts.reduce((s, a) => s + (a.credits ?? 0), 0),
      key_credits_used: key.credits_used,
      key_credits_left: key.credits_quota == null ? null : Math.max(0, key.credits_quota - key.credits_used),
      accounts: accounts.filter((a) => a.status === 'active').length,
    });
    return true;
  }

  if (p === '/v1/usage' && req.method === 'GET') {
    json(res, 200, {
      object: 'usage',
      key: { id: key.id, name: key.name, prefix: key.prefix },
      requests: key.usage.requests,
      images: key.usage.images,
      failed: key.usage.failed,
      credits_used: key.credits_used,
      credits_quota: key.credits_quota,
      daily_requests: key.daily_requests,
      day_count: key.usage.day_count,
      rpm: key.rpm,
      last_used_at: key.last_used_at,
    });
    return true;
  }

  if (p === '/v1/dashboard/billing/subscription' && req.method === 'GET') {
    json(res, 200, {
      object: 'billing_subscription',
      has_payment_method: true,
      soft_limit_usd: 1000,
      hard_limit_usd: 1000,
      system_hard_limit_usd: 1000,
      access_until: Math.floor(Date.now() / 1000) + 86400 * 365,
      plan: { title: 'upscale-2api', id: key.id },
    });
    return true;
  }

  if (p === '/v1/dashboard/billing/credit_grants' && req.method === 'GET') {
    json(res, 200, {
      object: 'credit_summary',
      total_granted: key.credits_quota ?? null,
      total_used: key.credits_used,
      total_available: key.credits_quota == null ? null : Math.max(0, key.credits_quota - key.credits_used),
      grants: [],
    });
    return true;
  }

  oaiError(res, 404, 'unknown endpoint: ' + p, { code: 'not_found' });
  return true;
}
