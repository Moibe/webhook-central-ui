// Envío de correo por el servicio HTTP de notificaciones de ART Broker, el mismo que usa Nexus (Biblioratum):
//
//   POST {URL}/OAuth/AuthToken                          {usr, psd}  ->  {results:{accessToken}, error, msgResponse}
//   POST {URL}/II_1_General_Notifications/Emailsending  Bearer      ->  {error, msgResponse}     (mailBody es HTML)
//
// Es un port del modo `api` de nexus_back/servicios/correo.py, con sus mismas reglas:
//  · El REMITENTE lo decide el servicio; aquí no hay "from" (en Nexus sale como «ART»).
//  · El token se guarda en memoria hasta ~1 min antes de su `exp` (5 min si no se le puede leer). Un 401/403 al enviar lo
//    renueva UNA vez. Un timeout o un 5xx NO se reintentan: el servicio pudo haberlo aceptado y el correo se duplicaría.
//  · HTTP 200 con `error: true` (o sin JSON) es una falla.
//  · Solo https, porque ahí viajan usuario, contraseña y token; http únicamente hacia localhost (las pruebas).
//  · Ni el log ni los errores llevan el cuerpo del correo (trae la contraseña), el token ni las credenciales, aunque el
//    servicio los repita en su respuesta.
//
// Configuración, con los MISMOS nombres que en Nexus para poder copiarlos tal cual: CORREO_API_URL, CORREO_API_USUARIO,
// CORREO_API_CONTRASENA y, opcionales, CORREO_TIMEOUT (segundos, 10 por defecto) y APP_URL (el enlace del correo).
// Salen del entorno del proceso o de `.env.server` en la raíz del proyecto; si están en los dos, gana el entorno.
// `.env.server` se relee en cada llamada: crearlo o editarlo no requiere reiniciar. Es un archivo APARTE de `.env` a
// propósito: Vite lee `.env` al compilar y expone al navegador lo que empiece con VITE_; estas credenciales nunca deben
// acercarse a eso.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = resolve(HERE, '../.env.server');

// Las rutas son fijas: entre ambientes solo cambia el host
const ROUTE_TOKEN = '/OAuth/AuthToken';
const ROUTE_SEND = '/II_1_General_Notifications/Emailsending';
const TOKEN_MARGIN_S = 60; // se renueva así de antes de que venza
const TOKEN_UNKNOWN_TTL_S = 300; // y dura esto si no se le puede leer el vencimiento
const DEFAULT_TIMEOUT_S = 10;
// `mailRecipients` es UNA cadena y el servicio podría tomar `;` o `,` como separador de varios destinatarios
const BAD_RECIPIENT = /[;,<>"\s]/;

export class MailError extends Error {
  // code: not_configured | bad_config | insecure_url | bad_recipient | auth | rejected | timeout | network
  constructor(code, message) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

// ── Configuración ───────────────────────────────────────────────────────────

// El texto entre comillas (la primera del valor es la que abre), o null si no hay comilla de cierre. Una barra invertida
// escapa \\ \' \" (y \n en comillas dobles); cualquier otra se queda tal cual. Lo que siga al cierre (un comentario) se ignora.
function unquote(value) {
  const quote = value[0];
  let out = '';
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      const next = value[i + 1];
      if (next === '\\' || next === "'" || next === '"') {
        out += next;
        i += 1;
        continue;
      }
      if (next === 'n' && quote === '"') {
        out += '\n';
        i += 1;
        continue;
      }
    }
    if (ch === quote) return out;
    out += ch;
  }
  return null;
}

// KEY=valor, `#` comentarios, `export KEY=...` y comillas simples o dobles (misma lectura que dotenv, que es la que
// ya leyó estas líneas en Nexus)
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value[0] === '"' || value[0] === "'") value = unquote(value) ?? value;
    else value = value.replace(/\s+#.*$/, ''); // comentario al final, solo en valores sin comillas
    out[m[1]] = value;
  }
  return out;
}

function fileValues() {
  try {
    return parseEnvFile(readFileSync(process.env.MAIL_ENV_FILE ?? DEFAULT_ENV_FILE, 'utf8'));
  } catch (e) {
    // Sin archivo es el estado normal de "no configurado"; cualquier otra cosa (permisos...) sí hay que decirla
    if (e.code !== 'ENOENT') console.error(`No se pudo leer .env.server (${e.code ?? e.name}): el envío de correo queda sin configurar`);
    return {};
  }
}

export function readConfig() {
  const file = fileValues();
  const get = (name) => String(process.env[name] ?? file[name] ?? '');
  const seconds = Number(get('CORREO_TIMEOUT'));
  return {
    url: get('CORREO_API_URL').trim().replace(/\/+$/, ''),
    user: get('CORREO_API_USUARIO').trim(),
    password: get('CORREO_API_CONTRASENA'),
    timeoutMs: (seconds > 0 ? seconds : DEFAULT_TIMEOUT_S) * 1000,
    appUrl: get('APP_URL').trim().replace(/\/+$/, ''),
  };
}

const complete = (c) => !!(c.url && c.user && c.password);

// ¿Hay con qué mandar correo? Solo mira que estén las tres variables; no llama al servicio.
export const isConfigured = () => complete(readConfig());

// ── Token ───────────────────────────────────────────────────────────────────

let cached = { key: '', value: null, expiresAt: 0 }; // expiresAt en segundos desde la época; solo en memoria
let inflight = null; // { key, promise }: un solo pedido de token a la vez, los demás reusan el suyo

// Cuándo vence: su claim `exp` (sin verificar la firma, que no es nuestra) o, si no es un JWT legible, dentro de 5 min
function expiryOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const exp = typeof payload.exp === 'string' ? Number(payload.exp) : payload.exp;
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp;
  } catch {
    // no es un JWT
  }
  return Date.now() / 1000 + TOKEN_UNKNOWN_TTL_S;
}

// Quita de un texto lo que NO debe llegar a un log ni a un mensaje de error por si el servicio lo repitiera: credenciales,
// token, cuerpo del correo y cualquier enlace. Lo acorta a 200 caracteres.
function scrub(text, c, mailBody = '') {
  let out = String(text ?? '');
  for (const secret of [c.user, c.password, cached.value, mailBody]) if (secret) out = out.split(secret).join('***');
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^https?:\/\//i.test(word) ? '<enlace>' : word))
    .join(' ')
    .slice(0, 200);
}

const reason = (json, c, mailBody) => {
  const msg = json && typeof json === 'object' ? scrub(json.msgResponse, c, mailBody) : '';
  return msg ? `: ${msg}` : '';
};

async function post(c, route, payload, headers = {}) {
  try {
    const res = await fetch(c.url + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      redirect: 'manual', // el usuario, la contraseña y el token no deben seguir a un redireccionamiento
      signal: AbortSignal.timeout(c.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // no era JSON
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json };
  } catch (e) {
    // Solo el tipo de la falla: nunca el cuerpo ni las cabeceras
    const host = new URL(c.url).host;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new MailError('timeout', 'El servicio de correo no respondió a tiempo. Puede que el correo sí haya salido: revisa la bandeja antes de reintentar.');
    }
    throw new MailError('network', `No se pudo conectar con el servicio de correo (${host}): ${e?.cause?.code ?? e?.name ?? 'error'}`);
  }
}

async function requestToken(c, key) {
  const res = await post(c, ROUTE_TOKEN, { usr: c.user, psd: c.password });
  const token = res.json?.results?.accessToken;
  if (!res.ok || res.json?.error || !token) {
    throw new MailError('auth', `El servicio de correo no aceptó las credenciales del servidor (HTTP ${res.status})${reason(res.json, c)}`);
  }
  cached = { key, value: String(token), expiresAt: expiryOf(String(token)) };
  return cached.value;
}

function getToken(c, force = false) {
  const key = `${c.url}\n${c.user}\n${c.password}`; // si cambian las credenciales, el token de las anteriores no sirve
  if (!force && cached.key === key && cached.value && Date.now() / 1000 < cached.expiresAt - TOKEN_MARGIN_S) {
    return Promise.resolve(cached.value);
  }
  if (inflight?.key === key) return inflight.promise;
  const promise = requestToken(c, key).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { key, promise };
  return promise;
}

// ── Envío ───────────────────────────────────────────────────────────────────

// Manda UN correo HTML a UN destinatario. Devuelve a dónde fue (`api://host`) y levanta MailError si no se pudo.
export async function sendMail({ to, subject, html }) {
  if (typeof to !== 'string' || !to.includes('@') || BAD_RECIPIENT.test(to)) {
    throw new MailError('bad_recipient', 'El correo del usuario no es válido para el servicio de envío');
  }
  const c = readConfig();
  if (!complete(c)) throw new MailError('not_configured', 'El envío de correo no está configurado en el servidor');
  let url;
  try {
    url = new URL(c.url);
  } catch {
    throw new MailError('bad_config', 'CORREO_API_URL no es una URL válida');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new MailError('insecure_url', 'CORREO_API_URL debe ser https: ahí viajan el usuario, la contraseña y el token');
  }

  const payload = { mailRecipients: to, mailCc: '', mailBcc: '', mailSubject: subject, mailBody: html };
  let res;
  for (const attempt of [1, 2]) {
    const token = await getToken(c, attempt === 2);
    res = await post(c, ROUTE_SEND, payload, { Authorization: `Bearer ${token}` });
    if ((res.status === 401 || res.status === 403) && attempt === 1) continue; // el token pudo vencer: se pide otro UNA vez
    break;
  }
  if (!res.ok || !res.json || typeof res.json !== 'object' || res.json.error) {
    // Con HTTP 200 y error:true el código no dice nada (confunde); solo se muestra cuando el estado no es 2xx
    const http = res.ok ? '' : ` (HTTP ${res.status})`;
    throw new MailError('rejected', `El servicio de correo rechazó el envío${http}${reason(res.json, c, html)}`);
  }
  return `api://${url.host}`;
}
