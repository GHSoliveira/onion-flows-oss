import path from 'node:path';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  return args.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
};

dotenv.config({ path: path.resolve(readArg('env', '.env')), override: true });

const requestedAdapter = readArg('adapter');
if (requestedAdapter) {
  process.env.DB_ADAPTER = requestedAdapter;
  process.env.USE_JSON_DB = requestedAdapter === 'json' ? 'true' : 'false';
}

const username = String(process.env.ADMIN_INITIAL_USERNAME || 'admin').trim();
const name = String(process.env.ADMIN_INITIAL_NAME || 'Super Admin').trim();
const password = String(process.env.ADMIN_INITIAL_PASSWORD || '');

if (!username) throw new Error('ADMIN_INITIAL_USERNAME invalido');
if (password.length < 12) throw new Error('ADMIN_INITIAL_PASSWORD deve ter ao menos 12 caracteres');

const { default: adapter } = await import('../db/DatabaseAdapter.js');

try {
  await adapter.init();
  const existing = await adapter.findOne('users', { username });
  if (existing) {
    console.log('[ADMIN_SEED] Usuario ja existe. Nenhuma alteracao realizada.');
  } else {
    const timestamp = new Date().toISOString();
    await adapter.insertOne('users', {
      id: `u_superadmin_${Date.now()}`,
      name,
      username,
      password: await bcrypt.hash(password, 12),
      role: 'SUPER_ADMIN',
      queues: [],
      permissions: ['*'],
      tenantId: null,
      status: 'offline',
      mustChangePassword: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    console.log('[ADMIN_SEED] Super-admin criado com sucesso.');
  }
} finally {
  await adapter.close();
}
