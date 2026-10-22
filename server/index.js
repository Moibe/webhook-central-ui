import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4174);
const DIST = resolve(process.env.DIST_DIR ?? resolve(HERE, '../dist'));
const APPS_FILE = process.env.APPS_FILE ?? '/home/mbriseno/webhook-central/apps.json';
const LOGS_DIR = resolve(process.env.LOGS_DIR ?? '/home/mbriseno/webhook-central/logs');
const COOKIE = 'wc_session';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

const tabOf = (app) => (app.env === 'prod' || app.env === 'open' ? app.env : 'dev');

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cookieToken(req) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return m?.[1] ?? null;
}

const setCookie = (token, maxAgeS) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('Body demasiado grande');
  }
  return raw ? JSON.parse(raw) : {};
}

// Freno básico a fuerza bruta: 8 intentos fallidos por IP cada 10 min
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 600_000);
  failures.set(ip, recent);
  return recent.length >= 8;
}

async function allowedApps(user) {
  const apps = JSON.parse(await readFile(APPS_FILE, 'utf8'));
  return apps.filter((a) => user.role === 'superadmin' || user.tabs.includes(tabOf(a)));
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const ip = req.socket.remoteAddress;

  if (path === '/api/login' && req.method === 'POST') {
    if (tooManyFailures(ip)) return send(res, 429, { error: 'Demasiados intentos, espera unos minutos' });
    const { username, password } = await readBody(req);
    const user = typeof username === 'string' && typeof password === 'string' && store.authenticate(username, password);
    if (!user) {
      failures.get(ip).push(Date.now());
      return send(res, 401, { error: 'Usuario o contraseña incorrectos' });
    }
    const { token, maxAgeS } = store.createSession(user.username);
    return send(res, 200, { user: store.publicUser(user) }, { 'Set-Cookie': setCookie(token, maxAgeS) });
  }

  const token = cookieToken(req);
  const user = store.userForSession(token);

  if (path === '/api/logout' && req.method === 'POST') {
    if (token) store.destroySession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
  }

  if (!user) return send(res, 401, { error: 'No autenticado' });

  if (path === '/api/me') return send(res, 200, { user: store.publicUser(user) });

  if (path === '/api/password' && req.method === 'POST') {
    const { current, next } = await readBody(req);
    try {
      store.changePassword(user.username, current, next, token);
      return send(res, 200, { user: store.publicUser(store.userForSession(token)) });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // Con contraseña temporal solo se puede cambiarla (o salir)
  if (user.must_change) return send(res, 403, { error: 'Debes cambiar tu contraseña', must_change: true });

  if (path === '/api/apps') return send(res, 200, await allowedApps(user));

  if (path === '/api/deploys') {
    const ids = new Set((await allowedApps(user)).map((a) => a.id));
    let text = '';
    try { text = await readFile(resolve(LOGS_DIR, 'deploys.jsonl'), 'utf8'); } catch { return send(res, 404, 'sin logs'); }
    const lines = text.split('\n').filter((l) => {
      try { return ids.has(JSON.parse(l).app); } catch { return false; }
    });
    return send(res, 200, lines.join('\n'));
  }

  if (path.startsWith('/api/logs/')) {
    const file = resolve(LOGS_DIR, decodeURIComponent(path.slice('/api/logs/'.length)));
    const rel = file.slice(LOGS_DIR.length + 1);
    const appId = rel.split(sep)[0];
    if (!file.startsWith(LOGS_DIR + sep) || !(await allowedApps(user)).some((a) => a.id === appId)) {
      return send(res, 403, { error: 'Sin acceso' });
    }
    try { return send(res, 200, await readFile(file, 'utf8')); } catch { return send(res, 404, 'no encontrado'); }
  }

  if (path.startsWith('/api/users')) {
    if (user.role !== 'superadmin') return send(res, 403, { error: 'Solo superadmin' });
    const name = decodeURIComponent(path.slice('/api/users/'.length));
    try {
      if (path === '/api/users' && req.method === 'GET') return send(res, 200, store.listUsers());
      if (path === '/api/users' && req.method === 'POST') {
        return send(res, 201, { ok: true, temp_password: store.createUser(await readBody(req)) });
      }
      if (name && req.method === 'PATCH') {
        return send(res, 200, { ok: true, temp_password: store.updateUser(name, await readBody(req)) });
      }
      if (name && req.method === 'DELETE') { store.deleteUser(name); return send(res, 200, { ok: true }); }
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  return send(res, 404, { error: 'No encontrado' });
}

async function handleStatic(res, url) {
  let file = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (file !== DIST && !file.startsWith(DIST + sep)) return send(res, 403, 'prohibido');
  let data;
  // apps.json y logs viejos pueden seguir como symlinks en dist/ (build previo): nunca servirlos sin auth
  const sensitive = /^\/(apps\.json|logs)(\/|$)/.test(url.pathname);
  try {
    if (sensitive) throw new Error('bloqueado');
    data = await readFile(file);
  } catch {
    file = resolve(DIST, 'index.html'); // fallback SPA
    data = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(data);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Error interno' });
  }
}).listen(PORT, () => console.log(`webhook-central-ui en :${PORT}`));
