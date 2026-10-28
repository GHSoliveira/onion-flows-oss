import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  return args.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
};

const envPath = path.resolve(readArg('env', '.env'));
dotenv.config({ path: envPath, override: true });

const sourcePath = path.resolve(readArg('source', process.env.JSON_DB_PATH || './sandbox/data/db.json'));
const tableName = process.env.POSTGRES_DOCUMENTS_TABLE || 'app_documents';
const batchSize = Math.max(1, Math.min(1000, Number.parseInt(readArg('batch', '250'), 10) || 250));
const dryRun = args.includes('--dry-run');

if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) throw new Error('POSTGRES_DOCUMENTS_TABLE invalido');
if (!fs.existsSync(sourcePath)) throw new Error(`Arquivo JSON nao encontrado: ${sourcePath}`);

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8') || '{}');
const summary = Object.fromEntries(
  Object.entries(source).map(([name, documents]) => [name, Array.isArray(documents) ? documents.length : 0])
);
const total = Object.values(summary).reduce((sum, count) => sum + count, 0);

console.log('[POSTGRES_MIGRATE] Fonte:', sourcePath);
console.log('[POSTGRES_MIGRATE] Colecoes:', Object.keys(summary).length);
console.log('[POSTGRES_MIGRATE] Documentos:', total);

if (dryRun) {
  console.log('[POSTGRES_MIGRATE] Dry-run concluido. Nenhuma escrita realizada.');
  process.exit(0);
}

const sslMode = String(process.env.PGSSLMODE || 'require').toLowerCase();
const caPath = String(process.env.PGSSL_CA_PATH || '').trim();
const pool = new Pool({
  max: 2,
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
  port: process.env.DATABASE_URL ? undefined : Number.parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.DATABASE_URL ? undefined : (process.env.PGDATABASE || 'postgres'),
  user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
  password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
  ssl: sslMode === 'disable' ? undefined : {
    rejectUnauthorized: String(process.env.PGSSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false',
    ...(caPath ? { ca: fs.readFileSync(caPath, 'utf8') } : {})
  },
  application_name: 'onion-flows-json-migration'
});

const client = await pool.connect();
try {
  const probe = await client.query(`select to_regclass('public.${tableName}') as table_name`);
  if (!probe.rows[0]?.table_name) throw new Error(`Tabela ${tableName} nao encontrada`);

  await client.query('BEGIN');
  for (const [collection, documents] of Object.entries(source)) {
    if (!Array.isArray(documents) || !documents.length) continue;
    let migrated = 0;
    for (let offset = 0; offset < documents.length; offset += batchSize) {
      const batch = documents.slice(offset, offset + batchSize);
      for (const original of batch) {
        const doc = JSON.parse(JSON.stringify(original || {}));
        if (!doc.id) doc.id = randomUUID();
        await client.query(
          `insert into ${tableName} (collection, id, tenant_id, doc)
           values ($1, $2, $3, $4::jsonb)
           on conflict (collection, id) do update
           set tenant_id = excluded.tenant_id, doc = excluded.doc, updated_at = now()`,
          [collection, String(doc.id), doc.tenantId == null ? null : String(doc.tenantId), JSON.stringify(doc)]
        );
        migrated += 1;
      }
    }
    console.log(`[POSTGRES_MIGRATE] ${collection}: ${migrated}`);
  }
  await client.query('COMMIT');
  console.log('[POSTGRES_MIGRATE] Migracao concluida com sucesso.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
