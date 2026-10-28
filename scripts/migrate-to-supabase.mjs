import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config({ path: './.env' });

const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME || 'onionflow';
const supabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || '';
const tableName = process.env.SUPABASE_DOCUMENTS_TABLE || 'app_documents';
const chunkSize = Number.parseInt(process.env.SUPABASE_MIGRATION_CHUNK_SIZE || '250', 10) || 250;

const collections = [
  'tenants',
  'users',
  'flows',
  'variables',
  'activeChats',
  'templates',
  'messageTemplates',
  'schedules',
  'queues',
  'tags',
  'webhooks',
  'cannedResponses',
  'channelConfigs',
  'systemLogs',
  'webVitals',
  'outreachCampaigns',
  'mediaAssets',
  'catalogItems',
  'contacts',
  'tenantSettings',
  'telegramSessions',
  'whatsappTemplates',
  'whatsappInteractiveTemplates'
];

if (!mongoUri) throw new Error('MONGODB_URI nao definido.');
if (!supabaseUrl) throw new Error('SUPABASE_URL nao definido.');
if (!supabaseKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY nao definido.');

const request = async (method, pathname, { query = {}, body, headers = {} } = {}) => {
  const url = new URL(`${supabaseUrl}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${method} ${pathname} falhou: ${response.status} ${text}`);
  }

  return response;
};

const chunk = (items, size) => {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const normalizeDoc = (doc) => {
  const next = JSON.parse(JSON.stringify(doc || {}));
  delete next._id;
  if (!next.id) {
    throw new Error(`Documento sem id detectado: ${JSON.stringify(next).slice(0, 200)}`);
  }
  return next;
};

const client = new MongoClient(mongoUri);

try {
  await client.connect();
  const db = client.db(mongoDbName);

  for (const collectionName of collections) {
    const docs = (await db.collection(collectionName).find({}).toArray()).map(normalizeDoc);
    if (!docs.length) {
      console.log(`[SUPABASE_MIGRATE] ${collectionName}: 0 documentos`);
      continue;
    }

    const payloads = docs.map((doc) => ({
      collection: collectionName,
      id: doc.id,
      tenant_id: doc.tenantId ?? null,
      doc
    }));

    for (const batch of chunk(payloads, chunkSize)) {
      await request('POST', `/rest/v1/${tableName}`, {
        query: { on_conflict: 'collection,id' },
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: batch
      });
    }

    console.log(`[SUPABASE_MIGRATE] ${collectionName}: ${docs.length} documentos`);
  }

  console.log('[SUPABASE_MIGRATE] Migracao concluida');
} finally {
  await client.close();
}
