// Proyecto de cada app editable desde la UI: todos lo leen (de sus apps), solo el superadmin lo cambia.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createTcpServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

describe('/api/projects (servidor real)', () => {
  let dir;
  let child;
  let base;
  let out = '';
  let root;
  let ana;

  async function session(username, password) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200, `login de ${username}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (path, method = 'GET', body) => {
      const r = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
  }

  const put = (api, id, project) => api(`/api/projects/${encodeURIComponent(id)}`, 'PUT', { project });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wcui-proj-'));
    writeFileSync(join(dir, 'apps.json'), JSON.stringify([
      { id: 'mide-chatbot', name: 'Mide Chatbot', owner: 'ana' },
      { id: 'nueva_app', name: 'Nueva', owner: 'ana' },
      { id: 'ajena', name: 'Ajena', owner: 'otro' },
    ]));
    process.env.DATA_FILE = join(dir, 'users.json');
    const store = await import('./store.js');
    store.upsertSuperadmin('root', 'clave-del-root-1');
    const temp = store.createUser({ username: 'ana' });
    store.changePassword('ana', temp, 'clave-de-ana-1', null);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), APPS_FILE: join(dir, 'apps.json'), LOGS_DIR: join(dir, 'logs'), DIST_DIR: join(dir, 'dist'), MAIL_ENV_FILE: join(dir, 'x') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const until = Date.now() + 10000;
    while (!out.includes(`en :${port}`)) {
      if (Date.now() > until) throw new Error('el servidor no arrancó');
      await new Promise((ok) => setTimeout(ok, 25));
    }
    root = await session('root', 'clave-del-root-1');
    ana = await session('ana', 'clave-de-ana-1');
  });

  after(async () => {
    await new Promise((ok) => (child.exitCode !== null ? ok() : (child.once('exit', ok), child.kill())));
    delete process.env.DATA_FILE;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('sin sesión: 401 al leer y al escribir', async () => {
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    const res = await fetch(`${base}/api/projects/nueva_app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"project":"X"}' });
    assert.equal(res.status, 401);
  });

  it('arranca con el mapa inicial, y cada quien ve solo el de sus apps', async () => {
    assert.deepEqual((await root('/api/projects')).json, { 'mide-chatbot': 'Mide' });
    assert.deepEqual((await ana('/api/projects')).json, { 'mide-chatbot': 'Mide' });
  });

  it('un usuario común no puede cambiar el proyecto: 403 y nada cambia', async () => {
    const res = await put(ana, 'nueva_app', 'Pirata');
    assert.equal(res.status, 403);
    assert.deepEqual((await root('/api/projects')).json, { 'mide-chatbot': 'Mide' });
  });

  it('el superadmin asigna uno nuevo (limpia espacios) y queda registrado en el log', async () => {
    const res = await put(root, 'nueva_app', '  Proyecto   Nuevo ');
    assert.equal(res.status, 200);
    assert.equal(res.json.project, 'Proyecto Nuevo');
    assert.equal((await ana('/api/projects')).json.nueva_app, 'Proyecto Nuevo');
    assert.match(out, /Proyecto de nueva_app → Proyecto Nuevo · por root/);
  });

  it('elegir uno existente con otras mayúsculas reusa el nombre existente', async () => {
    const res = await put(root, 'ajena', 'mide');
    assert.equal(res.json.project, 'Mide');
    assert.equal((await ana('/api/projects')).json.ajena, undefined, 'ana no ve apps ajenas');
  });

  it('vacío quita el proyecto', async () => {
    assert.equal((await put(root, 'mide-chatbot', '')).json.project, '');
    assert.equal((await root('/api/projects')).json['mide-chatbot'], undefined);
  });

  it('se guarda en el archivo de datos (sobrevive a un reinicio)', () => {
    const db = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
    assert.equal(db.projects.nueva_app, 'Proyecto Nuevo');
    assert.equal(db.projects['mide-chatbot'], undefined);
    assert.equal(db.projects.santander_ia, 'Santander', 'el resto del mapa inicial se conserva');
  });

  it('rechaza app inexistente, nombre largo o con caracteres raros', async () => {
    assert.equal((await put(root, 'no-existe', 'X')).status, 404);
    assert.equal((await put(root, 'nueva_app', 'x'.repeat(41))).status, 400);
    assert.equal((await put(root, 'nueva_app', '<script>')).status, 400);
    assert.equal((await root('/api/projects')).json.nueva_app, 'Proyecto Nuevo');
  });
});
