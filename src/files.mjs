import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from './config.mjs';
import { atomicWriteJson, debounce, now, readJson, uuid } from './util.mjs';
import { resign } from './session.mjs';

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

const index = new Map();
const INDEX_FILE = path.join(paths.files, '..', 'files.json');

const persistIndex = debounce(async () => {
  await atomicWriteJson(INDEX_FILE, { version: 1, files: [...index.values()] }, 0o600);
}, 200);

export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 10).toString() === 'WE') return '.webp';
  if (buf.slice(4, 8).toString() === 'ftyp') return '.mp4';
  if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
  if (buf.slice(0, 3).toString() === 'ID3') return '.mp3';
  return null;
}

export async function loadFileIndex() {
  const j = await readJson(INDEX_FILE, { files: [] });
  index.clear();
  for (const f of j.files ?? []) index.set(f.name, f);
  try {
    const names = await fs.readdir(paths.files);
    let added = 0;
    for (const name of names) {
      if (index.has(name) || name.startsWith('.')) continue;
      const st = await fs.stat(path.join(paths.files, name));
      if (!st.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      index.set(name, {
        name,
        bytes: st.size,
        mime: MIME[ext] ?? 'application/octet-stream',
        created_at: st.mtime.toISOString(),
        source: 'adopted',
        remote: null,
      });
      added += 1;
    }
    if (added) persistIndex();
  } catch {
    /* dir missing on first run */
  }
}

export async function fetchBytes(url) {
  const tryOnce = async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch(u, { signal: ctl.signal });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };
  let buf = await tryOnce(url);
  if (!buf) {
    const alt = await resign(url);
    if (alt !== url) buf = await tryOnce(alt);
  }
  return buf;
}

export async function persist(url, { source = 'generation' } = {}) {
  const name0 = uuid();
  const buf = await fetchBytes(url);
  if (!buf) return { id: name0, remote: url, local: null, name: null };
  const ext = sniff(buf) ?? '.bin';
  const name = name0 + ext;
  await fs.mkdir(paths.files, { recursive: true });
  await fs.writeFile(path.join(paths.files, name), buf);
  const meta = {
    name,
    bytes: buf.length,
    mime: MIME[ext] ?? 'application/octet-stream',
    created_at: new Date().toISOString(),
    source,
    remote: url,
  };
  index.set(name, meta);
  persistIndex();
  return { id: name0, remote: url, local: '/files/' + name, name, bytes: buf.length, mime: meta.mime };
}

export async function persistBuffer(buf, ext) {
  const name = uuid() + ext;
  await fs.mkdir(paths.files, { recursive: true });
  await fs.writeFile(path.join(paths.files, name), buf);
  index.set(name, {
    name,
    bytes: buf.length,
    mime: MIME[ext] ?? 'application/octet-stream',
    created_at: new Date().toISOString(),
    source: 'upload',
  });
  persistIndex();
  return '/files/' + name;
}

export async function serveFile(res, name) {
  const safe = path.basename(String(name));
  const full = path.join(paths.files, safe);
  try {
    const buf = await fs.readFile(full);
    const ext = path.extname(safe).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

export function fileStats() {
  let bytes = 0;
  for (const f of index.values()) bytes += f.bytes ?? 0;
  return { count: index.size, bytes };
}

export function listFiles(limit = 100) {
  return [...index.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);
}

export async function cleanupRetention() {
  if (!config.retentionDays) return { removed: 0 };
  const cutoff = now() - config.retentionDays * 86400000;
  let removed = 0;
  for (const [name, meta] of index) {
    if (new Date(meta.created_at).getTime() > cutoff) continue;
    try {
      await fs.unlink(path.join(paths.files, name));
      removed += 1;
    } catch {
      /* already gone */
    }
    index.delete(name);
  }
  if (removed) persistIndex();
  return { removed };
}
