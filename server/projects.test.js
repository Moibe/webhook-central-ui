// Proyecto de cada app editable desde la UI: todos lo leen (de sus apps), solo el superadmin lo cambia.
// Regla: el proyecto es de la app, no del ambiente — Dev, Staging y Prod de una misma app dicen lo mismo.
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

// Levanta el servidor real sobre `dir` (users.json y apps.json ya escritos ahí)
async function boot(dir) {
  const port = await freePort();
  const srv = { base: `http://127.0.0.1:${port}`, out: '' };
  const child = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_FILE: join(dir, 'users.json'), APPS_FILE: join(dir, 'apps.json'), LOGS_DIR: join(dir, 'logs'), DIST_DIR: join(dir, 'dist'), MAIL_ENV_FILE: join(dir, 'x') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}

const put = (api, id, project) => api(`/api/projects/${encodeURIComponent(id)}`, 'PUT', { project });
const rename = (api, from, to) => api('/api/projects/rename', 'POST', { from, to });

describe('/api/projects (servidor real)', () => {
  let dir;
  let srv;
  let root;
  let ana;
  const fileDb = () => JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
  const fileMap = () => fileDb().app_projects;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wcui-proj-'));
    writeFileSync(join(dir, 'apps.json'), JSON.stringify([
      { id: 'mide-chatbot', name: 'Mide Chatbot', owner: 'ana', env: 'prod' },
      { id: 'nueva_app', name: 'Nueva', owner: 'ana' },
      { id: 'ajena', name: 'Ajena', owner: 'otro' },
      { id: 'fam_dev', name: 'Fam (Dev)', owner: 'ana', env: 'dev' },
      { id: 'fam_staging', name: 'Fam (Staging)', owner: 'ana', env: 'staging' },
      { id: 'fam', name: 'Fam', owner: 'ana', env: 'prod' },
    ]));
    process.env.DATA_FILE = join(dir, 'users.json');
    const store = await import('./store.js');
    store.upsertSuperadmin('root', 'clave-del-root-1');
    const temp = store.createUser({ username: 'ana' });
    store.changePassword('ana', temp, 'clave-de-ana-1', null);
    srv = await boot(dir);
    root = await session(srv, 'root', 'clave-del-root-1');
    ana = await session(srv, 'ana', 'clave-de-ana-1');
  });

  after(async () => {
    await srv.stop();
    delete process.env.DATA_FILE;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('sin sesión: 401 al leer y al escribir', async () => {
    assert.equal((await fetch(`${srv.base}/api/projects`)).status, 401);
    const res = await fetch(`${srv.base}/api/projects/nueva_app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"project":"X"}' });
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
    assert.equal(res.json.map.nueva_app, 'Proyecto Nuevo', 'la respuesta trae el mapa ya actualizado');
    assert.equal((await ana('/api/projects')).json.nueva_app, 'Proyecto Nuevo');
    assert.match(srv.out, /Proyecto de nueva_app \(todos sus ambientes\) → Proyecto Nuevo · por root/);
  });

  it('regla: cambiarlo desde Staging lo cambia también en Dev y en Prod', async () => {
    const res = await put(root, 'fam_staging', 'Familia');
    assert.equal(res.status, 200);
    for (const id of ['fam_dev', 'fam_staging', 'fam']) assert.equal(res.json.map[id], 'Familia', id);
    const seen = (await ana('/api/projects')).json;
    for (const id of ['fam_dev', 'fam_staging', 'fam']) assert.equal(seen[id], 'Familia', `${id} para ana`);
    assert.equal(fileMap().fam, 'Familia', 'se guarda una sola vez, por app');
    assert.equal(fileMap().fam_staging, undefined);
  });

  it('regla: cambiarlo desde Prod también lo cambia en Dev; y vaciarlo lo quita de los tres', async () => {
    assert.equal((await put(root, 'fam', 'Familia Dos')).json.map.fam_dev, 'Familia Dos');
    const res = await put(root, 'fam_dev', '');
    for (const id of ['fam_dev', 'fam_staging', 'fam']) assert.equal(res.json.map[id], undefined, id);
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
    const db = fileDb();
    assert.equal(db.app_projects.nueva_app, 'Proyecto Nuevo');
    assert.equal(db.app_projects['mide-chatbot'], undefined);
    assert.equal(db.app_projects.santander_ia, 'Santander', 'el resto del mapa inicial se conserva');
    assert.equal(db.projects, undefined, 'ya no existe el mapa por instancia');
  });

  it('rechaza app inexistente, nombre largo o con caracteres raros', async () => {
    assert.equal((await put(root, 'no-existe', 'X')).status, 404);
    assert.equal((await put(root, 'nueva_app', 'x'.repeat(41))).status, 400);
    assert.equal((await put(root, 'nueva_app', '<script>')).status, 400);
    assert.equal((await root('/api/projects')).json.nueva_app, 'Proyecto Nuevo');
  });

  it('renombrar: un usuario común recibe 403 y nada cambia', async () => {
    assert.equal((await rename(ana, 'Mide', 'Otro')).status, 403);
    assert.equal(fileMap().ajena, 'Mide');
  });

  it('renombrar cambia todas las apps del proyecto, también las que no están en apps.json visible', async () => {
    const before = Object.entries(fileMap()).filter(([, v]) => v === 'Mide').map(([k]) => k).sort();
    assert.ok(before.length >= 3, 'Mide tiene varias apps (ajena + las del mapa inicial)');
    const res = await rename(root, 'Mide', '  Mide   Chat ');
    assert.equal(res.status, 200);
    assert.equal(res.json.project, 'Mide Chat');
    assert.equal(res.json.map.ajena, 'Mide Chat', 'la respuesta trae el mapa ya actualizado');
    const map = fileMap();
    for (const id of before) assert.equal(map[id], 'Mide Chat');
    assert.ok(!Object.values(map).includes('Mide'));
    assert.match(srv.out, /Proyecto Mide → Mide Chat \(\d+ apps\) · por root/);
  });

  it('cambiar solo mayúsculas renombra (no se confunde con "ya existe")', async () => {
    assert.equal((await rename(root, 'Mide Chat', 'MIDE CHAT')).json.project, 'MIDE CHAT');
    assert.equal(fileMap().ajena, 'MIDE CHAT');
  });

  it('renombrar al nombre de otro proyecto los junta bajo el existente', async () => {
    const res = await rename(root, 'Proyecto Nuevo', 'santander');
    assert.equal(res.json.project, 'Santander');
    assert.equal(fileMap().nueva_app, 'Santander');
    assert.ok(!Object.values(fileMap()).includes('Proyecto Nuevo'));
  });

  it('renombrar: vacío o inválido 400, proyecto inexistente 404', async () => {
    assert.equal((await rename(root, 'Santander', '   ')).status, 400);
    assert.equal((await rename(root, 'Santander', 'a<b')).status, 400);
    assert.equal((await rename(root, 'No Existe', 'X')).status, 404);
    assert.equal(fileMap().nueva_app, 'Santander');
  });
});

describe('migración: del proyecto por instancia al proyecto por app (manda Dev)', () => {
  let dir;
  let srv;
  let root;
  const legacy = {
    fam_dev: 'Alfa', fam_staging: 'Gama', fam: 'Beta', // los tres distintos: gana Dev
    dos_staging: 'Ese', dos: 'Pe', //                    sin Dev: gana Staging
    tres_dev: '', tres: 'Equis', //                      Dev vacío: no borra, gana el que sí tiene
    solo: 'Uno',
  };
  const fileDb = () => JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wcui-mig-'));
    const ids = ['fam_dev', 'fam_staging', 'fam', 'dos_staging', 'dos', 'tres_dev', 'tres', 'solo'];
    writeFileSync(join(dir, 'apps.json'), JSON.stringify(ids.map((id) => ({ id, name: id }))));
    const { hashPassword } = await import('./store.js');
    writeFileSync(join(dir, 'users.json'), JSON.stringify({
      users: { root: { username: 'root', hash: hashPassword('clave-del-root-1'), role: 'superadmin' } },
      sessions: {},
      projects: legacy,
    }));
    srv = await boot(dir);
    root = await session(srv, 'root', 'clave-del-root-1');
  });

  after(async () => {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('al arrancar unifica cada app en sus tres ambientes', async () => {
    assert.deepEqual((await root('/api/projects')).json, {
      fam_dev: 'Alfa', fam_staging: 'Alfa', fam: 'Alfa',
      dos_staging: 'Ese', dos: 'Ese',
      tres_dev: 'Equis', tres: 'Equis',
      solo: 'Uno',
    });
  });

  it('el log dice qué nombre se descartó y por qué', () => {
    assert.match(srv.out, /Proyecto unificado: fam decía "Beta", queda "Alfa" como fam_dev \(regla: manda Dev\)/);
    assert.match(srv.out, /Proyecto unificado: fam_staging decía "Gama", queda "Alfa"/);
    assert.match(srv.out, /Proyecto unificado: dos decía "Pe", queda "Ese" como dos_staging/);
    assert.equal((srv.out.match(/Proyecto unificado/g) ?? []).length, 3, 'solo lo que de verdad cambió');
  });

  it('guarda el mapa por app y respalda el viejo tal cual', () => {
    const db = fileDb();
    assert.deepEqual(db.app_projects, { fam: 'Alfa', dos: 'Ese', tres: 'Equis', solo: 'Uno' });
    assert.deepEqual(db.projects_legacy, legacy);
    assert.equal(db.projects, undefined);
  });

  it('corre una sola vez: al reiniciar no vuelve a migrar ni a avisar', async () => {
    await srv.stop();
    srv = await boot(dir);
    assert.ok(!srv.out.includes('Proyecto unificado'));
    root = await session(srv, 'root', 'clave-del-root-1');
    assert.equal((await root('/api/projects')).json.fam, 'Alfa');
  });
});
