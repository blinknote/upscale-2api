import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBool, parseList } from './util.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const FILES = path.join(DATA, 'files');
export const PUBLIC = path.join(ROOT, 'public');

function loadDotEnv() {
  for (const name of ['.env.local', '.env']) {
    const f = path.join(ROOT, name);
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) {
        continue;
      }
      if (process.env[m[1]] == null) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}
loadDotEnv();

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  supabaseUrl: process.env.SUPABASE_URL ?? 'https://otbhyhagqnrolexjxvon.supabase.co',
  anon: process.env.SUPABASE_ANON ?? '',
  host: process.env.HOST ?? '127.0.0.1',
  port: num(process.env.PORT, 8787),
  adminKey: process.env.ADMIN_KEY ?? 'admin',
  bootstrapKeys: parseList(process.env.API_KEYS),
  publicBase: String(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
  perAccount: Math.max(1, num(process.env.PER_ACCOUNT_CONCURRENCY, 2)),
  queueWaitMs: num(process.env.QUEUE_WAIT_MS, 90000),
  defaultModel: process.env.DEFAULT_MODEL ?? 'nano-banana',
  keepaliveMs: num(process.env.KEEPALIVE_MS, 5 * 60 * 1000),
  refreshWindowMs: num(process.env.REFRESH_WINDOW_MS, 15 * 60 * 1000),
  retentionDays: num(process.env.FILE_RETENTION_DAYS, 30),
  logRing: num(process.env.LOG_RING, 500),
  trustProxy: parseBool(process.env.TRUST_PROXY, false),
  maxBodyBytes: num(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024),
  bucket: 'generated-assets',
};

export const paths = {
  accounts: path.join(DATA, 'accounts.json'),
  keys: path.join(DATA, 'keys.json'),
  stats: path.join(DATA, 'stats.json'),
  files: FILES,
};

export function missingConfig() {
  const miss = [];
  if (!config.anon) miss.push('SUPABASE_ANON');
  return miss;
}
