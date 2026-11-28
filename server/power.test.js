// Apagar/encender y refrescar dev: el navegador llama a /api/power y /api/refresh y el SERVIDOR agrega el token
// (leído de .power_token). El token nunca viaja al navegador ni se acepta desde él.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'token-de-prueba-0123456789';

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createTcpServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

// Webhook falso: registra cada llamada y contesta como power.sh / refresh.sh
async function fakeWebhook() {
  const calls = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: u.pathname, params: Object.fromEntries(u.searchParams) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.searchParams.get('token') !== TOKEN) return res.end(JSON.stringify({ ok: false, error: 'token inválido' }));
    if (u.pathname === '/hooks/power') return res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ ok: true, run_id: 'r1' }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, stop: () => new Promise((ok) => srv.close(ok)) };
}

async function boot(dir, webhookUrl) {
  const port = await freePort();
  const srv = { base: `http://127.0.0.1:${port}`, out: '' };
  const env = { ...process.env, PORT: String(port), DATA_FILE: join(dir, 'users.json'), APPS_FILE: join(dir, 'apps.json'), LOGS_DIR: join(dir, 'logs'), DIST_DIR: join(dir, 'dist'), MAIL_ENV_FILE: join(dir, 'x'), WEBHOOK_URL: webhookUrl };
  delete env.POWER_TOKEN;
  delete env.POWER_TOKEN_FILE; // por defecto: .power_token junto a apps.json, como en el servidor
  const child = spawn(process.execPath, [join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (srv.out += d));
  child.stderr.on('data', (d) => (srv.out += d));
  srv.stop = () => new Promise((ok) => (child.exitCode !== null ? ok() : (child.once('exit', ok), child.kill())));
  const until = Date.now() + 10000;
  while (!srv.out.includes(`en :${port}`)) {
    if (Date.now() > until) throw new Error('el servidor no arrancó:\n' + srv.out);
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return srv;
}

async function session(srv, username, password) {
  const res = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login de ${username}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, method = 'GET', body) => {
    const r = await fetch(srv.base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
}

describe('/api/power y /api/refresh (servidor real + webhook falso)', () => {
  let dir, srv, hook, root, ana;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wcui-power-'));
    writeFileSync(join(dir, 'apps.json'), JSON.stringify([
      { id: 'app_dev', name: 'App (Dev)', owner: 'ana', env: 'dev', pm2_name: 'app-dev', refresh_url: '/hooks/refrescar-app_dev', refresh_undo_url: '/hooks/deshacer-refresco-app_dev' },
      { id: 'app', name: 'App', owner: 'ana', env: 'prod', pm2_name: 'app', refresh_url: '/hooks/refrescar-app' },
      { id: 'listener', name: 'Listener', owner: 'root', pm2_name: 'webhook-listener' },
      { id: 'raro_dev', name: 'Raro', owner: 'root', env: 'dev', refresh_url: 'http://otro-host/x' },
    ]));
    writeFileSync(join(dir, '.power_token'), TOKEN + '\n');
    process.env.DATA_FILE = join(dir, 'users.json');
    const store = await import('./store.js');
    store.upsertSuperadmin('root', 'clave-del-root-1');
    const temp = store.createUser({ username: 'ana' });
    store.changePassword('ana', temp, 'clave-de-ana-1', null);
    hook = await fakeWebhook();
    srv = await boot(dir, hook.url);
    root = await session(srv, 'root', 'clave-del-root-1');
    ana = await session(srv, 'ana', 'clave-de-ana-1');
  });

  after(async () => {
    await srv.stop();
    await hook.stop();
    delete process.env.DATA_FILE;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('sin sesión: 401', async () => {
    const r = await fetch(`${srv.base}/api/power`, { method: 'POST', body: '{"id":"app","action":"stop"}' });
    assert.equal(r.status, 401);
  });

  it('un usuario común no puede, aunque la app sea suya', async () => {
    assert.equal((await ana('/api/power')).status, 403);
    assert.equal((await ana('/api/power', 'POST', { id: 'app', action: 'stop' })).status, 403);
    assert.equal((await ana('/api/refresh', 'POST', { id: 'app_dev' })).status, 403);
    assert.equal(hook.calls.length, 0);
  });

  it('GET /api/power solo dice si está habilitado: nunca devuelve el token', async () => {
    const r = await root('/api/power');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { enabled: true });
    assert.ok(!r.text.includes(TOKEN));
  });

  it('apagar: el servidor agrega el token y la respuesta no lo trae', async () => {
    const r = await root('/api/power', 'POST', { id: 'app', action: 'stop' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.ok(!r.text.includes(TOKEN));
    const c = hook.calls.at(-1);
    assert.deepEqual(c, { method: 'POST', path: '/hooks/power', params: { action: 'stop', id: 'app', token: TOKEN } });
    assert.ok(!srv.out.includes(TOKEN), 'el token no aparece en los logs');
  });

  it('un token mandado por el navegador se ignora', async () => {
    await root('/api/power', 'POST', { id: 'app', action: 'start', token: 'pirata' });
    assert.equal(hook.calls.at(-1).params.token, TOKEN);
  });

  it('valida acción, app y apps protegidas sin llamar al hook', async () => {
    const n = hook.calls.length;
    assert.equal((await root('/api/power', 'POST', { id: 'app', action: 'delete' })).status, 400);
    assert.equal((await root('/api/power', 'POST', { id: 'no-existe', action: 'stop' })).status, 404);
    assert.equal((await root('/api/power', 'POST', { id: 'listener', action: 'stop' })).status, 400);
    assert.equal(hook.calls.length, n);
  });

  it('refrescar y deshacer usan el hook de la app (solo dev)', async () => {
    let r = await root('/api/refresh', 'POST', { id: 'app_dev', mode: 'refrescar' });
    assert.deepEqual(r.json, { ok: true, run_id: 'r1' });
    assert.equal(hook.calls.at(-1).path, '/hooks/refrescar-app_dev');
    assert.equal(hook.calls.at(-1).params.token, TOKEN);
    r = await root('/api/refresh', 'POST', { id: 'app_dev', mode: 'deshacer' });
    assert.equal(hook.calls.at(-1).path, '/hooks/deshacer-refresco-app_dev');
    const n = hook.calls.length;
    assert.equal((await root('/api/refresh', 'POST', { id: 'app' })).status, 400, 'prod no se refresca');
    assert.equal((await root('/api/refresh', 'POST', { id: 'raro_dev' })).status, 400, 'solo rutas /hooks/... del mismo webhook');
    assert.equal(hook.calls.length, n);
  });

  it('sin .power_token: deshabilitado y 503 sin llamar al hook', async () => {
    rmSync(join(dir, '.power_token'));
    assert.deepEqual((await root('/api/power')).json, { enabled: false });
    const n = hook.calls.length;
    assert.equal((await root('/api/power', 'POST', { id: 'app', action: 'stop' })).status, 503);
    assert.equal(hook.calls.length, n);
  });
});
