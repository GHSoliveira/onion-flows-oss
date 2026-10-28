import bcrypt from 'bcrypt';
import adapter from '../../db/DatabaseAdapter.js';

export const verifyUserPassword = async (user, password) => {
  const storedPassword = String(user?.password || '');
  const candidatePassword = String(password || '');

  if (!storedPassword || !candidatePassword) {
    return false;
  }

  const isBcryptHash = /^\$2[aby]\$/.test(storedPassword);

  if (!isBcryptHash) {
    // Legacy plaintext password — reject and force reset
    return false;
  }

  return bcrypt.compare(candidatePassword, storedPassword);
};

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();

// Antes o username so era unico dentro do tenant, entao ainda pode haver o
// mesmo nome em mais de um. O login testa a senha em cada um (mais antigo
// primeiro) e entra no que bater, em vez de pegar um qualquer.
export const findUserByLogin = async (username, password) => {
  if (!adapter.db) await adapter.init();
  const candidates = (await adapter.findDocuments('users', { username }))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const candidate of candidates) {
    if (await verifyUserPassword(candidate, password)) return candidate;
  }
  return null;
};

// Username e o login: unico na plataforma inteira, sem diferenciar maiuscula.
export const isUsernameTaken = async (username, exceptUserId = null) => {
  const wanted = normalizeUsername(username);
  if (!wanted) return false;
  if (!adapter.db) await adapter.init();
  const users = await adapter.findDocuments('users', {});
  return users.some((user) => user.id !== exceptUserId && normalizeUsername(user.username) === wanted);
};

/**
 * One-time migration: hash all plaintext passwords still in the database.
 * Run once via: node -e "import('./src/services/passwords.js').then(m => m.migratePlaintextPasswords())"
 */
export const migratePlaintextPasswords = async () => {
  if (!adapter.db) {
    await adapter.init();
  }
  const users = await adapter.db.collection('users').find({}).toArray();
  let migrated = 0;
  for (const user of users) {
    const pw = String(user.password || '');
    if (pw && !/^\$2[aby]\$/.test(pw)) {
      const hashed = await bcrypt.hash(pw, 10);
      await adapter.db.collection('users').updateOne(
        { id: user.id },
        { $set: { password: hashed, updatedAt: new Date().toISOString() } }
      );
      migrated++;
    }
  }
  console.log(`[PASSWORD MIGRATION] ${migrated} passwords hashed.`);
  return migrated;
};
