#!/usr/bin/env node
import http from 'node:http';
import { config } from './src/config.mjs';
import { json, preflight, send } from './src/http.mjs';
import { loadFileIndex, serveFile, cleanupRetention, fileStats } from './src/files.mjs';
import { loadKeys, flushKeys } from './src/keys.mjs';
import { record } from './src/logs.mjs';
import { handle as adminRoute } from './src/routes/admin.mjs';
import { handle as openaiRoute } from './src/routes/openai.mjs';
import { accounts, flushAccounts, loadAccounts, startKeepalive } from './src/session.mjs';
import { shortId } from './src/util.mjs';

if (!config.anon) {
  console.error('SUPABASE_ANON is required. Put it in .env or the environment.');
  process.exit(1);
}

await loadAccounts();
await loadKeys();
await loadFileIndex();
startKeepalive();
cleanupRetention().catch(() => {});
const cleaner = setInterval(() => cleanupRetention().catch(() => {}), 6 * 3600 * 1000);
if (cleaner.unref) cleaner.unref();

const startedAt = Date.now();

async function route(req, res) {
  const rid = shortId('req');
  res.setHeader('x-request-id', rid);
  const t0 = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host ?? 'localhost'));
  const p = decodeURIComponent(url.pathname);
  let status = 0;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, ...rest) => {
    status = code;
    return origWriteHead(code, ...rest);
  };

  res.on('finish', () => {
    record({
      id: rid,
      method: req.method,
      path: p,
      status: status || res.statusCode,
      ms: Date.now() - t0,
      ip: req.socket?.remoteAddress ?? null,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 80),
    });
  });

  if (req.method === 'OPTIONS') return preflight(res);

  if (p === '/healthz') {
    return json(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      accounts: accounts.length,
      files: fileStats(),
    });
  }

  if (p === '/readyz') {
    const ok = config.anon && accounts.some((a) => a.status === 'active');
    return json(res, ok ? 200 : 503, { ready: ok, accounts: accounts.length });
  }

  if (p.startsWith('/files/')) {
    const done = await serveFile(res, p.slice('/files/'.length));
    return done || json(res, 404, { error: 'file not found' });
  }

  if (p === '/' || p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/')) {
    const handled = await adminRoute(req, res, p, url);
    if (handled) return;
  }

  if (p.startsWith('/v1/')) {
    const handled = await openaiRoute(req, res, p, url);
    if (handled) return;
  }

  if (p === '/') {
    res.writeHead(302, { location: '/admin' });
    return res.end();
  }

  json(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error', code: 'not_found' } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e?.status ?? 500;
    if (!res.headersSent) json(res, status, { error: { message: String(e?.message ?? e), type: 'server_error' } });
    else res.end();
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(config.port, config.host, () => {
  console.log(`upscale-2api v1.0.0  http://${config.host}:${config.port}  accounts=${accounts.length}`);
  console.log(`panel: http://${config.host}:${config.port}/admin   api: /v1`);
});

async function shutdown(sig) {
  console.log('shutting down on ' + sig);
  server.close();
  try {
    await flushAccounts();
    await flushKeys();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
