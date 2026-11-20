import { config } from './config.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'x-request-id, x-ratelimit-remaining, retry-after',
};

export function send(res, status, body, headers = {}) {
  const h = { ...CORS, ...headers };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    h['Content-Type'] = h['Content-Type'] ?? 'text/plain; charset=utf-8';
    res.writeHead(status, h);
    return res.end(body);
  }
  h['Content-Type'] = h['Content-Type'] ?? 'application/json; charset=utf-8';
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

export const json = (res, status, obj, headers) => send(res, status, obj, headers);

export function oaiError(res, status, message, { type = 'invalid_request_error', param = null, code = null, headers } = {}) {
  json(res, status, { error: { message, type, param, code } }, headers);
}

export function preflight(res) {
  res.writeHead(204, CORS);
  res.end();
}

export function readBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  const txt = buf.toString('utf8');
  try {
    return JSON.parse(txt);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

export function splitBuffer(buf, delim) {
  const parts = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(delim, from);
    if (i < 0) break;
    parts.push(buf.slice(from, i));
    from = i + delim.length;
  }
  parts.push(buf.slice(from));
  return parts;
}

export function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const fields = {};
  const files = [];
  for (const raw of splitBuffer(buf, delim)) {
    if (!raw.length || raw.slice(0, 2).toString() === '--') continue;
    let part = raw;
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = part.slice(0, sep).toString('utf8');
    const data = part.slice(sep + 4);
    const nameM = head.match(/name="([^"]*)"/i);
    const fileM = head.match(/filename="([^"]*)"/i);
    const typeM = head.match(/content-type:\s*([^\r\n]+)/i);
    const name = nameM ? nameM[1] : null;
    if (!name) continue;
    if (fileM) {
      files.push({ field: name, filename: fileM[1], mime: typeM ? typeM[1].trim() : 'application/octet-stream', data });
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  return { fields, files };
}

export async function readMultipart(req, limit) {
  const ct = String(req.headers['content-type'] ?? '');
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw Object.assign(new Error('multipart boundary missing'), { status: 400 });
  const buf = await readBody(req, limit);
  return parseMultipart(buf, (m[1] || m[2]).trim());
}

export function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

export function bearerOf(req) {
  const a = String(req.headers.authorization ?? '');
  const m = a.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const k = req.headers['x-api-key'];
  if (k) return String(k).trim();
  return null;
}

export function absBase(req) {
  if (config.publicBase) return config.publicBase;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1:' + config.port)
    .split(',')[0]
    .trim();
  return proto + '://' + host;
}
