// Pruebas del envío de la contraseña temporal por correo. Se corren con `npm test`.
// Nada sale a la red real: el servicio de ART es un servidor falso en localhost y el servidor de la app corre como proceso
// aparte contra él, con sus propios datos en una carpeta temporal.
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail, isConfigured, readConfig, MailError } from './mail.js';
import { passwordEmail, BRAND } from './mail-templates.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_KEYS = ['CORREO_API_URL', 'CORREO_API_USUARIO', 'CORREO_API_CONTRASENA', 'CORREO_TIMEOUT', 'APP_URL', 'MAIL_ENV_FILE'];

// ── El servicio de ART, falseado ────────────────────────────────────────────

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
// Un JWT como los del servicio: solo se lee `exp`; la "firma" no importa y sirve de número de serie del token
const jwt = (exp, serial) => `${b64({ alg: 'none' })}.${b64({ exp })}.serie${serial}`;

const defaultToken = ({ json, n }) => json(200, { count: 1, results: { accessToken: jwt(nowS() + 3600, n) }, error: false, msgResponse: 'ok' });
const defaultSend = ({ json }) => json(200, { count: 1, results: null, error: false, msgResponse: 'enviado' });

// `handlers.token` / `handlers.send` reciben { req, res, body, json, n } (n = cuántas llamadas van a esa ruta). Se pueden
// cambiar a media prueba reasignando `art.handlers`.
async function fakeArt(handlers = {}) {
  const art = { calls: { token: [], send: [], paths: [] }, handlers: { ...handlers } };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const ctx = {
      req,
      res,
      body: raw ? JSON.parse(raw) : null,
      json: (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      },
    };
    art.calls.paths.push(req.url);
    if (req.url === '/OAuth/AuthToken') {
      art.calls.token.push({ body: ctx.body });
      ctx.n = art.calls.token.length;
      return (art.handlers.token ?? defaultToken)(ctx);
    }
    if (req.url === '/II_1_General_Notifications/Emailsending') {
      art.calls.send.push({ body: ctx.body, auth: req.headers.authorization });
      ctx.n = art.calls.send.length;
      return (art.handlers.send ?? defaultSend)(ctx);
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  art.url = `http://127.0.0.1:${server.address().port}`;
  art.close = () =>
    new Promise((ok) => {
      server.closeAllConnections();
      server.close(ok);
    });
  return art;
}

const MAIL = { to: 'ana@grupocsi.com', subject: 'Tus accesos', html: '<p>tu contraseña es zx9k2</p>' };
const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e instanceof MailError && e.code === code, `debía fallar con ${code}`);

// ── mail.js ─────────────────────────────────────────────────────────────────

describe('mail.js · servicio de ART', () => {
  let saved;
  let dir;
  let serial = 0;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'wcui-mail-'));
    process.env.MAIL_ENV_FILE = join(dir, '.env.server'); // que nunca lea el del proyecto
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Levanta el servicio falso, lo configura por entorno (con credenciales propias de esta prueba) y corre `fn`
  async function withArt(handlers, fn) {
    const art = await fakeArt(handlers);
    try {
      serial += 1;
      process.env.CORREO_API_URL = art.url;
      process.env.CORREO_API_USUARIO = `usuario-secreto-${serial}`;
      process.env.CORREO_API_CONTRASENA = `clave-secreta-${serial}`;
      await fn(art);
    } finally {
      await art.close();
    }
  }

  it('manda el correo con el contrato del servicio', () =>
    withArt({}, async (art) => {
      const via = await sendMail(MAIL);
      assert.equal(via, `api://${new URL(art.url).host}`);
      assert.deepEqual(art.calls.token[0].body, { usr: process.env.CORREO_API_USUARIO, psd: process.env.CORREO_API_CONTRASENA });
      assert.deepEqual(art.calls.send[0].body, {
        mailRecipients: MAIL.to,
        mailCc: '',
        mailBcc: '',
        mailSubject: MAIL.subject,
        mailBody: MAIL.html,
      });
      assert.match(art.calls.send[0].auth, /^Bearer .+\.serie1$/);
    }));

  it('guarda el token y no lo pide en cada envío', () =>
    withArt({}, async (art) => {
      await sendMail(MAIL);
      await sendMail(MAIL);
      assert.equal(art.calls.token.length, 1);
      assert.equal(art.calls.send.length, 2);
      assert.equal(art.calls.send[0].auth, art.calls.send[1].auth);
    }));

  it('renueva el token antes de que venza (margen de 60 s)', () =>
    withArt({ token: ({ json, n }) => json(200, { results: { accessToken: jwt(nowS() + 30, n) }, error: false }) }, async (art) => {
      await sendMail(MAIL);
      await sendMail(MAIL);
      assert.equal(art.calls.token.length, 2);
    }));

  it('un token que no es JWT se guarda 5 minutos', () =>
    withArt({ token: ({ json }) => json(200, { results: { accessToken: 'token-opaco' }, error: false }) }, async (art) => {
      await sendMail(MAIL);
      await sendMail(MAIL);
      assert.equal(art.calls.token.length, 1);
      assert.equal(art.calls.send[1].auth, 'Bearer token-opaco');
    }));

  for (const status of [401, 403]) {
    it(`un ${status} al enviar renueva el token UNA vez y reintenta UNA vez`, () =>
      withArt({ send: (ctx) => (ctx.n === 1 ? ctx.json(status, { error: true, msgResponse: 'token vencido' }) : defaultSend(ctx)) }, async (art) => {
        await sendMail(MAIL);
        assert.equal(art.calls.token.length, 2);
        assert.equal(art.calls.send.length, 2);
        assert.match(art.calls.send[1].auth, /\.serie2$/);
      }));
  }

  it('dos 401 seguidos fallan sin más reintentos', () =>
    withArt({ send: ({ json }) => json(401, { error: true, msgResponse: 'no autorizado' }) }, async (art) => {
      await rejectsWith(sendMail(MAIL), 'rejected');
      assert.equal(art.calls.token.length, 2);
      assert.equal(art.calls.send.length, 2);
    }));

  it('HTTP 200 con error:true es una falla y dice el motivo del servicio', () =>
    withArt({ send: ({ json }) => json(200, { error: true, msgResponse: 'Destinatario no permitido' }) }, async () => {
      await assert.rejects(sendMail(MAIL), (e) => e.code === 'rejected' && e.message.includes('Destinatario no permitido') && !e.message.includes('HTTP'));
    }));

  it('HTTP 200 sin JSON es una falla', () =>
    withArt(
      {
        send: ({ res }) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>ok</html>');
        },
      },
      async () => rejectsWith(sendMail(MAIL), 'rejected'),
    ));

  it('un 5xx NO se reintenta (el correo podría haber salido)', () =>
    withArt({ send: ({ json }) => json(500, { error: true, msgResponse: 'boom' }) }, async (art) => {
      await assert.rejects(sendMail(MAIL), (e) => e.code === 'rejected' && /HTTP 500/.test(e.message) && e.message.includes('boom'));
      assert.equal(art.calls.send.length, 1);
      assert.equal(art.calls.token.length, 1);
    }));

  it('un timeout NO se reintenta y avisa que quizá sí salió', () =>
    withArt({ send: () => {} }, async (art) => {
      process.env.CORREO_TIMEOUT = '0.25';
      await assert.rejects(sendMail(MAIL), (e) => e.code === 'timeout' && /sí haya salido/.test(e.message));
      assert.equal(art.calls.send.length, 1);
      assert.equal(art.calls.token.length, 1);
    }));

  it('si no hay conexión, falla con `network`', async () => {
    process.env.CORREO_API_URL = 'http://127.0.0.1:1'; // nadie escucha ahí
    process.env.CORREO_API_USUARIO = 'u';
    process.env.CORREO_API_CONTRASENA = 'p';
    await rejectsWith(sendMail(MAIL), 'network');
  });

  const tokenFailures = {
    'credenciales rechazadas (401)': ({ json, body }) => json(401, { error: true, msgResponse: `usuario ${body.usr} con ${body.psd} no es válido` }),
    'token vacío': ({ json }) => json(200, { results: { accessToken: '' }, error: false }),
    'error:true': ({ json }) => json(200, { results: null, error: true, msgResponse: 'nope' }),
  };
  for (const [name, token] of Object.entries(tokenFailures)) {
    it(`si el servicio no entrega token (${name}) no se intenta enviar y no se filtran las credenciales`, () =>
      withArt({ token }, async (art) => {
        await assert.rejects(sendMail(MAIL), (e) => {
          assert.equal(e.code, 'auth');
          assert.ok(!e.message.includes(process.env.CORREO_API_USUARIO), 'el mensaje deja ver el usuario');
          assert.ok(!e.message.includes(process.env.CORREO_API_CONTRASENA), 'el mensaje deja ver la contraseña');
          return true;
        });
        assert.equal(art.calls.send.length, 0);
      }));
  }

  for (const to of ['a@b.com;c@d.com', 'a@b.com,c@d.com', 'a b@c.com', ' a@b.com', '<a@b.com>', '"a"@b.com', 'sin-arroba', '', null]) {
    it(`no manda a un destinatario que el servicio podría tomar por varios o por basura (${JSON.stringify(to)})`, () =>
      withArt({}, async (art) => {
        await rejectsWith(sendMail({ ...MAIL, to }), 'bad_recipient');
        assert.equal(art.calls.paths.length, 0);
      }));
  }

  it('sin las tres variables no hay envío', async () => {
    assert.equal(isConfigured(), false);
    await rejectsWith(sendMail(MAIL), 'not_configured');
    process.env.CORREO_API_URL = 'https://servicio.ejemplo.com';
    process.env.CORREO_API_USUARIO = 'u';
    assert.equal(isConfigured(), false, 'falta la contraseña');
    process.env.CORREO_API_CONTRASENA = 'p';
    assert.equal(isConfigured(), true);
  });

  it('solo https (http únicamente hacia localhost)', async () => {
    process.env.CORREO_API_USUARIO = 'u';
    process.env.CORREO_API_CONTRASENA = 'p';
    process.env.CORREO_API_URL = 'http://servicio.ejemplo.com';
    await rejectsWith(sendMail(MAIL), 'insecure_url');
    process.env.CORREO_API_URL = 'no es una url';
    await rejectsWith(sendMail(MAIL), 'bad_config');
  });

  it('no sigue redireccionamientos (ahí viajan el usuario, la contraseña y el token)', () =>
    withArt(
      {
        send: ({ res }) => {
          res.writeHead(302, { Location: '/otro-lado' });
          res.end();
        },
      },
      async (art) => {
        await rejectsWith(sendMail(MAIL), 'rejected');
        assert.ok(!art.calls.paths.includes('/otro-lado'));
      },
    ));

  it('el mensaje de error no deja pasar credenciales, token, cuerpo del correo ni enlaces aunque el servicio los repita', () =>
    withArt(
      {
        send: ({ json, req, body }) =>
          json(500, {
            error: true,
            msgResponse:
              `falló. usuario=${process.env.CORREO_API_USUARIO} clave=${process.env.CORREO_API_CONTRASENA} ` +
              `token=${req.headers.authorization.slice(7)} cuerpo=${body.mailBody} ver https://interno.ejemplo.com/x?t=abc`,
          }),
      },
      async (art) => {
        let error;
        try {
          await sendMail(MAIL);
        } catch (e) {
          error = e;
        }
        assert.ok(error instanceof MailError);
        const token = art.calls.send[0].auth.slice('Bearer '.length);
        for (const secret of [process.env.CORREO_API_USUARIO, process.env.CORREO_API_CONTRASENA, token, 'zx9k2', 'https://']) {
          assert.ok(!error.message.includes(secret), `el mensaje deja ver «${secret}»`);
        }
        assert.match(error.message, /<enlace>/);
        assert.ok(error.message.length < 300, 'el motivo del servicio se acorta');
      },
    ));

  it('acorta el motivo del servicio: un mensaje enorme no llena el log ni la pantalla', () =>
    withArt({ send: ({ json }) => json(500, { error: true, msgResponse: 'palabra '.repeat(1000) }) }, async () => {
      await assert.rejects(sendMail(MAIL), (e) => e.code === 'rejected' && e.message.length < 300);
    }));

  it('cinco envíos a la vez piden UN solo token', () =>
    withArt(
      {
        token: async (ctx) => {
          await new Promise((ok) => setTimeout(ok, 150));
          defaultToken(ctx);
        },
      },
      async (art) => {
        await Promise.all(Array.from({ length: 5 }, () => sendMail(MAIL)));
        assert.equal(art.calls.token.length, 1);
        assert.equal(art.calls.send.length, 5);
      },
    ));

  it('si cambian las credenciales, el token de las anteriores no se reusa', () =>
    withArt({}, async (art) => {
      await sendMail(MAIL);
      process.env.CORREO_API_CONTRASENA = 'otra-clave';
      await sendMail(MAIL);
      assert.equal(art.calls.token.length, 2);
    }));

  it('lee `.env.server` (comillas, comentarios, CRLF), el entorno gana y se relee sin reiniciar', () => {
    const file = process.env.MAIL_ENV_FILE;
    const write = (lines) => writeFileSync(file, lines.join('\r\n'));
    assert.equal(isConfigured(), false, 'sin archivo no hay configuración y no truena');

    write([
      '# credenciales de prueba',
      'CORREO_API_URL=https://servicio.ejemplo.com/ ',
      'export CORREO_API_USUARIO = "usuario con espacios"',
      "CORREO_API_CONTRASENA='p#ss word'   # entre comillas, el # es parte de la clave",
      'APP_URL=https://panel.ejemplo.com # comentario al final',
      'CORREO_TIMEOUT=3',
    ]);
    assert.deepEqual(readConfig(), {
      url: 'https://servicio.ejemplo.com',
      user: 'usuario con espacios',
      password: 'p#ss word',
      timeoutMs: 3000,
      appUrl: 'https://panel.ejemplo.com',
    });
    assert.equal(isConfigured(), true);

    process.env.CORREO_API_USUARIO = 'del-entorno';
    assert.equal(readConfig().user, 'del-entorno', 'el entorno del proceso gana sobre el archivo');
    delete process.env.CORREO_API_USUARIO;

    write(['CORREO_API_URL=https://servicio.ejemplo.com', 'CORREO_API_USUARIO=u']); // se quita la contraseña
    assert.equal(isConfigured(), false, 'editar el archivo se nota sin reiniciar');

    rmSync(file);
    assert.equal(isConfigured(), false);
  });

  it('en `.env.server` las comillas aceptan escapes (\\" \\\' \\\\); otras barras se quedan tal cual; sin cierre no se toca', () => {
    writeFileSync(
      process.env.MAIL_ENV_FILE,
      [
        'CORREO_API_URL="https://servicio.ejemplo.com"',
        'CORREO_API_USUARIO="a\\"b\\\\c"', //   a"b\c
        "CORREO_API_CONTRASENA='x\\yz\\'w'", // x\yz'w
        'APP_URL="sin cierre',
      ].join('\n'),
    );
    const c = readConfig();
    assert.equal(c.user, 'a"b\\c');
    assert.equal(c.password, "x\\yz'w");
    assert.equal(c.appUrl, '"sin cierre');
  });
});

// ── mail-templates.js ───────────────────────────────────────────────────────

describe('mail-templates.js · correo de la contraseña temporal', () => {
  it('lleva usuario, contraseña, el nombre de la app y el botón', () => {
    const { subject, html } = passwordEmail({ username: 'ana.lopez', password: 'zx9k2', appUrl: 'https://panel.ejemplo.com' });
    assert.equal(BRAND, 'Buzzword IA DevOps', 'el nombre que ve la gente en la app');
    assert.equal(subject, `Tus accesos a ${BRAND}`);
    assert.ok(html.includes('ana.lopez') && html.includes('zx9k2') && html.includes(BRAND));
    assert.ok(html.includes('href="https://panel.ejemplo.com"'));
  });

  it('escapa lo que viene de fuera', () => {
    const { html } = passwordEmail({ username: '<img src=x onerror=alert(1)>', password: '"><script>x</script>', appUrl: 'https://p.com/?a=1&b=2' });
    assert.ok(!html.includes('<img') && !html.includes('<script'), 'quedó marcado sin escapar');
    assert.ok(html.includes('&lt;img') && html.includes('&lt;script&gt;'));
    assert.ok(html.includes('href="https://p.com/?a=1&amp;b=2"'));
  });

  for (const appUrl of ['', undefined, 'javascript:alert(1)', 'ftp://x.com', 'https://a b.com', 'https://x.com/"><script>']) {
    it(`no pone botón con un enlace que no sea http(s) válido (${JSON.stringify(appUrl)})`, () => {
      const { html } = passwordEmail({ username: 'ana', password: 'zx9k2', appUrl });
      assert.ok(!html.includes('<a '), 'salió un enlace');
      assert.ok(html.includes('zx9k2'), 'el correo sale igual, sin botón');
    });
  }
});

// ── Rutas: el servidor de verdad contra el ART falseado ─────────────────────

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createTcpServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitFor(cond, ms = 10000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('tiempo agotado esperando al servidor');
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

describe('POST /api/users/:u/send-password (servidor real, ART falseado)', () => {
  let dir;
  let art;
  let store;
  let A; // configurado por entorno
  let B; // configurado (y desconfigurado) con `.env.server`, sin reiniciar
  let rootA;
  let rootB;
  const servers = [];

  async function startServer(extraEnv, envFile) {
    const port = await freePort();
    const env = { ...process.env };
    for (const k of ENV_KEYS) delete env[k];
    Object.assign(env, {
      PORT: String(port),
      DATA_FILE: join(dir, 'users.json'),
      APPS_FILE: join(dir, 'apps.json'),
      LOGS_DIR: join(dir, 'logs'),
      DIST_DIR: join(dir, 'dist'),
      MAIL_ENV_FILE: envFile ?? join(dir, 'sin-archivo'),
      ...extraEnv,
    });
    const child = spawn(process.execPath, [join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const server = {
      base: `http://127.0.0.1:${port}`,
      out: '',
      stop: () => new Promise((ok) => (child.exitCode !== null ? ok() : (child.once('exit', ok), child.kill()))),
    };
    child.stdout.on('data', (d) => (server.out += d));
    child.stderr.on('data', (d) => (server.out += d));
    servers.push(server);
    await waitFor(() => server.out.includes(`en :${port}`));
    return server;
  }

  async function session(server, username, password) {
    const res = await fetch(`${server.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200, `login de ${username}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (path, method = 'GET', body) => {
      const r = await fetch(server.base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
  }

  const send = (api, username, channel = 'email') => api(`/api/users/${encodeURIComponent(username)}/send-password`, 'POST', { channel });
  const tempOf = async (api, username) => (await api('/api/users')).json.find((u) => u.username === username).temp_password;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wcui-e2e-'));
    writeFileSync(join(dir, 'apps.json'), '[]');
    process.env.DATA_FILE = join(dir, 'users.json'); // antes de importar el almacén, que lo lee al cargar
    store = await import('./store.js');
    store.upsertSuperadmin('root', 'clave-del-root-1');
    art = await fakeArt();
    A = await startServer({
      CORREO_API_URL: art.url,
      CORREO_API_USUARIO: 'usr-e2e-secreto',
      CORREO_API_CONTRASENA: 'clave-e2e-secreta',
      APP_URL: 'https://panel.ejemplo.test',
      CORREO_TIMEOUT: '0.6',
    });
    B = await startServer({}, join(dir, '.env.server'));
    rootA = await session(A, 'root', 'clave-del-root-1');
    rootB = await session(B, 'root', 'clave-del-root-1');
  });

  after(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await art.close();
    delete process.env.DATA_FILE;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('sin sesión: 401', async () => {
    const res = await fetch(`${A.base}/api/users/ana/send-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"channel":"email"}' });
    assert.equal(res.status, 401);
    assert.equal(art.calls.send.length, 0);
  });

  it('la lista dice si el correo está configurado: sí en A, no en B', async () => {
    assert.equal((await rootA('/api/users')).json.every((u) => u.mail_enabled === true), true);
    assert.equal((await rootB('/api/users')).json.every((u) => u.mail_enabled === false), true);
  });

  it('manda la contraseña temporal al correo del usuario, y solo eso', async () => {
    assert.equal((await rootA('/api/users', 'POST', { username: 'ana', email: 'ana@grupocsi.com' })).status, 201);
    assert.equal((await rootA('/api/users', 'POST', { username: 'beto' })).status, 201);
    const temp = await tempOf(rootA, 'ana');

    const res = await send(rootA, 'ana');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, email: 'ana@grupocsi.com' });
    assert.ok(!JSON.stringify(res.json).includes(temp), 'la respuesta no repite la contraseña');

    assert.equal(art.calls.send.length, 1);
    const { body } = art.calls.send[0];
    assert.equal(body.mailRecipients, 'ana@grupocsi.com');
    assert.equal(body.mailSubject, `Tus accesos a ${BRAND}`);
    assert.ok(body.mailBody.includes(temp) && body.mailBody.includes('ana') && body.mailBody.includes('https://panel.ejemplo.test'));
  });

  it('el log dice a quién y quién lo pidió, pero nunca la contraseña, el token ni las credenciales', async () => {
    const temp = await tempOf(rootA, 'ana');
    const token = art.calls.send[0].auth.slice('Bearer '.length);
    assert.match(A.out, /Correo enviado a ana@grupocsi\.com/);
    assert.match(A.out, /pedido por root/);
    for (const secret of [temp, token, 'usr-e2e-secreto', 'clave-e2e-secreta']) {
      assert.ok(!A.out.includes(secret), 'el log deja ver un secreto');
    }
  });

  it('dos clics seguidos no mandan dos correos (el segundo recibe 409)', async () => {
    const before = art.calls.send.length;
    art.handlers.send = async (ctx) => {
      await new Promise((ok) => setTimeout(ok, 250));
      defaultSend(ctx);
    };
    try {
      const [x, y] = await Promise.all([send(rootA, 'ana'), send(rootA, 'ana')]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409]);
      assert.equal(art.calls.send.length, before + 1);
    } finally {
      art.handlers.send = undefined;
    }
  });

  it('sin correo capturado, canal inválido o usuario inexistente: 400 y no se llama al servicio', async () => {
    const before = art.calls.paths.length;
    const sinCorreo = await send(rootA, 'beto');
    assert.equal(sinCorreo.status, 400);
    assert.match(sinCorreo.json.error, /no tiene correo/);
    assert.equal((await send(rootA, 'ana', 'sms')).status, 400);
    const fantasma = await send(rootA, 'nadie');
    assert.equal(fantasma.status, 400);
    assert.match(fantasma.json.error, /no encontrado/);
    assert.equal(art.calls.paths.length, before);
  });

  it('si el servicio rechaza: 502 con su motivo, sin la contraseña, y queda en el log', async () => {
    const temp = await tempOf(rootA, 'ana');
    art.handlers.send = ({ json }) => json(200, { error: true, msgResponse: 'Cuota excedida' });
    try {
      const res = await send(rootA, 'ana');
      assert.equal(res.status, 502);
      assert.match(res.json.error, /Cuota excedida/);
      assert.ok(!JSON.stringify(res.json).includes(temp));
      assert.match(A.out, /Correo NO enviado a ana@grupocsi\.com \(rejected\)/);
    } finally {
      art.handlers.send = undefined;
    }
  });

  it('si el servicio no responde: 504 y avisa que quizá sí salió', async () => {
    art.handlers.send = () => {};
    try {
      const res = await send(rootA, 'ana');
      assert.equal(res.status, 504);
      assert.match(res.json.error, /sí haya salido/);
    } finally {
      art.handlers.send = undefined;
    }
  });

  it('quien ya cambió su contraseña no tiene temporal que mandar; y un usuario común no puede pedirlo', async () => {
    const created = await rootA('/api/users', 'POST', { username: 'carla', email: 'carla@grupocsi.com' });
    store.changePassword('carla', created.json.temp_password, 'una-clave-propia-1', null);
    const res = await send(rootA, 'carla');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /ya definió/);

    const carla = await session(A, 'carla', 'una-clave-propia-1');
    const denied = await send(carla, 'ana');
    assert.equal(denied.status, 403);
    assert.equal((await carla('/api/users')).status, 403);
  });

  it('el superadmin no tiene contraseña temporal que mandar', async () => {
    const res = await send(rootA, 'root');
    assert.equal(res.status, 400);
  });

  it('sin configurar: 503; se configura con `.env.server` SIN reiniciar; y al quitarlo vuelve a apagarse', async () => {
    const file = join(dir, '.env.server');
    const before = art.calls.send.length;
    const off = await send(rootB, 'ana');
    assert.equal(off.status, 503);
    assert.match(off.json.error, /no está configurado/);

    writeFileSync(file, [`CORREO_API_URL=${art.url}`, 'CORREO_API_USUARIO=usr-archivo', 'CORREO_API_CONTRASENA=clave-archivo', 'APP_URL=https://desde-archivo.test'].join('\r\n'));
    assert.equal((await rootB('/api/users')).json.every((u) => u.mail_enabled === true), true, 'la lista lo nota sin reiniciar');
    const on = await send(rootB, 'ana');
    assert.equal(on.status, 200);
    assert.equal(art.calls.send.length, before + 1);
    assert.ok(art.calls.send.at(-1).body.mailBody.includes('https://desde-archivo.test'));
    assert.ok(art.calls.token.at(-1).body.usr === 'usr-archivo');

    rmSync(file);
    assert.equal((await rootB('/api/users')).json.every((u) => u.mail_enabled === false), true);
    assert.equal((await send(rootB, 'ana')).status, 503);
  });
});
