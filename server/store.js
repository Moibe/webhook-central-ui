import { scryptSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = process.env.DATA_FILE ?? resolve(HERE, '../data/users.json');
export const TABS = ['dev', 'staging', 'prod'];

function load() {
  if (!existsSync(DATA_FILE)) return { users: {}, sessions: {} };
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function save(db) {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  renameSync(tmp, DATA_FILE);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    email: u.email ?? '',
    phone: u.phone ?? '',
    tabs: [...TABS], // todos ven las pestañas; la visibilidad de apps depende del owner
    must_change: !!u.must_change,
  };
}

// Sin caracteres ambiguos (0/o, 1/l/i) para que se pueda dictar sin errores
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const tempPassword = () => Array.from({ length: 5 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');

function dropSessions(db, username, except) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.username === username && t !== except) delete db.sessions[t];
}

export function upsertSuperadmin(username, password) {
  const db = load();
  db.users[username] = {
    ...db.users[username],
    username,
    hash: hashPassword(password),
    role: 'superadmin',
    created_at: db.users[username]?.created_at ?? new Date().toISOString(),
  };
  save(db);
}

// El login no distingue mayúsculas: "moibe" entra como "Moibe"
const findUser = (db, username) =>
  db.users[username] ?? Object.values(db.users).find((u) => u.username.toLowerCase() === String(username).toLowerCase());

export function authenticate(username, password) {
  const u = findUser(load(), username);
  // Verificar siempre un hash para no filtrar por tiempo si el usuario existe
  const ok = verifyPassword(password, u?.hash ?? hashPassword('dummy'));
  return u && ok ? u : null;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(username) {
  const db = load();
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[t];
  const token = randomBytes(32).toString('hex');
  db.sessions[token] = { username, expires: now + SESSION_TTL_MS };
  save(db);
  return { token, maxAgeS: SESSION_TTL_MS / 1000 };
}

export function userForSession(token) {
  if (!token) return null;
  const db = load();
  const s = db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return db.users[s.username] ?? null; // permisos siempre frescos
}

export function destroySession(token) {
  const db = load();
  if (db.sessions[token]) {
    delete db.sessions[token];
    save(db);
  }
}

// Solo el superadmin ve la contraseña, y únicamente la temporal: al cambiarla se borra y queda el hash
export const listUsers = () =>
  Object.values(load().users).map((u) => ({ ...publicUser(u), temp_password: u.must_change ? u.temp_password : null }));

// Opcionales: vacío los borra
function cleanContact(email, phone) {
  const e = String(email ?? '').trim();
  const p = String(phone ?? '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Correo inválido');
  if (p && !/^\+?[0-9 ()-]{7,20}$/.test(p)) throw new Error('Celular inválido (7-20 dígitos, puede llevar + espacios - ( ))');
  return { email: e, phone: p };
}

export function createUser({ username, email, phone }) {
  const db = load();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username ?? '')) throw new Error('Usuario inválido (3-32: letras, números, . _ -)');
  if (findUser(db, username)) throw new Error('Ese usuario ya existe');
  const contact = cleanContact(email, phone);
  const temp = tempPassword();
  db.users[username] = {
    ...contact,
    username, hash: hashPassword(temp), temp_password: temp, must_change: true,
    role: 'user', created_at: new Date().toISOString(),
  };
  save(db);
  return temp;
}

export function updateUser(username, { reset, email, phone }) {
  const db = load();
  const u = db.users[username];
  if (!u) throw new Error('Usuario no encontrado');
  if (u.role === 'superadmin' && reset) throw new Error('La contraseña del superadmin no se restablece desde la UI');
  if (email !== undefined || phone !== undefined) {
    Object.assign(u, cleanContact(email ?? u.email, phone ?? u.phone));
  }
  let temp = null;
  if (reset) {
    temp = tempPassword();
    u.hash = hashPassword(temp);
    u.temp_password = temp;
    u.must_change = true;
    dropSessions(db, username);
  }
  save(db);
  return temp;
}

export function changePassword(username, current, next, sessionToken) {
  const db = load();
  const u = db.users[username];
  if (!u || !verifyPassword(current ?? '', u.hash)) throw new Error('La contraseña actual no es correcta');
  if (typeof next !== 'string' || next.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres');
  if (next === current) throw new Error('La nueva contraseña debe ser distinta');
  u.hash = hashPassword(next);
  u.must_change = false;
  delete u.temp_password;
  dropSessions(db, username, sessionToken);
  save(db);
}

export function deleteUser(username) {
  const db = load();
  const u = db.users[username];
  if (!u) throw new Error('Usuario no encontrado');
  if (u.role === 'superadmin') throw new Error('El superadmin no se puede borrar');
  delete db.users[username];
  for (const [t, s] of Object.entries(db.sessions)) if (s.username === username) delete db.sessions[t];
  save(db);
}
