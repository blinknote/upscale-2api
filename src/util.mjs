import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();
export const shortId = (p = 'req') => p + '_' + crypto.randomBytes(9).toString('base64url');

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function mask(v, head = 6, tail = 4) {
  const s = String(v ?? '');
  if (s.length <= head + tail) return s.slice(0, 2) + '***';
  return s.slice(0, head) + '…' + s.slice(-tail);
}

export function jwtInfo(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return { exp: (p.exp ?? 0) * 1000, sub: p.sub ?? null, email: p.email ?? null, role: p.role ?? null };
  } catch {
    return { exp: 0, sub: null, email: null, role: null };
  }
}

export async function atomicWriteJson(file, obj, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode });
  await fs.rename(tmp, file);
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function debounce(fn, ms) {
  let t = null;
  let pending = false;
  const run = async () => {
    t = null;
    pending = true;
    try { await fn(); } finally { pending = false; }
  };
  const wrapped = () => {
    if (t) return;
    t = setTimeout(run, ms);
    if (t.unref) t.unref();
  };
  wrapped.flush = async () => {
    if (t) { clearTimeout(t); t = null; }
    if (!pending) await run();
  };
  return wrapped;
}

export class RingLog {
  constructor(limit = 500) {
    this.limit = limit;
    this.items = [];
  }
  push(entry) {
    this.items.push({ ...entry, at: new Date().toISOString() });
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }
  list(n = 100) {
    return this.items.slice(-n).reverse();
  }
}

export function parseBool(v, dflt = false) {
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function parseList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
