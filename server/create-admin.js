// Uso: node server/create-admin.js   (crea o resetea el superadmin; pide la contraseña sin eco)
import readline from 'node:readline';
import { upsertSuperadmin, DATA_FILE } from './store.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise((r) => rl.question(q, r));

function askHidden(q) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(q)) write.call(rl, s); };
    rl.question(q, (a) => { rl._writeToOutput = write; process.stdout.write('\n'); resolve(a); });
  });
}

const username = (await ask('Usuario superadmin: ')).trim();
if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) { console.error('Usuario inválido (3-32: letras, números, . _ -)'); process.exit(1); }
const p1 = await askHidden('Contraseña (mín. 8): ');
const p2 = await askHidden('Repite la contraseña: ');
rl.close();
if (p1.length < 8) { console.error('La contraseña debe tener al menos 8 caracteres'); process.exit(1); }
if (p1 !== p2) { console.error('Las contraseñas no coinciden'); process.exit(1); }

upsertSuperadmin(username, p1);
console.log(`Superadmin "${username}" guardado en ${DATA_FILE}`);
