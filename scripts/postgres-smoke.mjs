import path from 'node:path';
import dotenv from 'dotenv';

const envArg = process.argv.find((item) => item.startsWith('--env='));
dotenv.config({ path: path.resolve(envArg?.slice('--env='.length) || '.env'), override: true });

process.env.DB_ADAPTER = 'postgres';
process.env.USE_JSON_DB = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const collectionName = `__postgres_smoke_${Date.now()}`;
const tenantId = `tenant_smoke_${Date.now()}`;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  await adapter.init();
  const collection = await adapter.collection(collectionName);

  await collection.insertOne({
    id: 'one',
    tenantId,
    status: 'pending',
    counter: 1,
    tags: ['initial'],
    createdAt: new Date().toISOString()
  });
  await collection.insertOne({ id: 'two', tenantId, status: 'ready', counter: 2 });

  const pending = await collection.findOne({ tenantId, status: 'pending' });
  assert(pending?.id === 'one', 'findOne por tenant/status falhou');

  const update = await collection.updateOne(
    { id: 'one', tenantId },
    { $set: { status: 'ready' }, $inc: { counter: 2 }, $push: { tags: 'updated' } }
  );
  assert(update.modifiedCount === 1, 'updateOne falhou');

  const updated = await collection.findOne({ id: 'one', tenantId });
  assert(updated?.status === 'ready', 'status atualizado nao persistiu');
  assert(updated?.counter === 3, 'incremento nao persistiu');
  assert(updated?.tags?.includes('updated'), 'push nao persistiu');

  const rows = await collection.find({ tenantId }).sort({ counter: -1 }).limit(2).toArray();
  assert(rows.length === 2, 'find/sort/limit falhou');
  assert(rows[0].id === 'one', 'ordenacao falhou');

  const count = await collection.countDocuments({ tenantId, status: 'ready' });
  assert(count === 2, 'countDocuments falhou');

  const deleted = await collection.deleteMany({ tenantId });
  assert(deleted.deletedCount === 2, 'deleteMany falhou');
  assert(await collection.countDocuments({ tenantId }) === 0, 'limpeza do smoke falhou');

  console.log('[POSTGRES_SMOKE] PASS');
} finally {
  await adapter.close();
}
