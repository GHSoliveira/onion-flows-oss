import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'onionflow';

const COLLECTIONS_TO_MIGRATE = ['variables', 'messageTemplates', 'flows', 'schedules', 'tags', 'cannedResponses', 'webhooks', 'users'];

async function migrateTenantId() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI nao definido. Configure no .env antes de executar a migracao.');
  }

  console.log('Iniciando migracao de tenantId...');
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('Conectado ao MongoDB');
    const db = client.db(DB_NAME);

    const tenants = await db.collection('tenants').find({}).toArray();
    const targetTenant = tenants[0];

    if (!targetTenant) {
      throw new Error('Nenhum tenant encontrado para migracao.');
    }

    console.log(`Tenant alvo: ${targetTenant.name} (${targetTenant.id})`);
    console.log('Antes da migracao:');

    for (const col of COLLECTIONS_TO_MIGRATE) {
      const total = await db.collection(col).countDocuments();
      const without = await db.collection(col).countDocuments({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }] });
      console.log(`  ${col}: ${without}/${total} sem tenantId`);
    }

    console.log('Aplicando migracao...');
    for (const col of COLLECTIONS_TO_MIGRATE) {
      const result = await db.collection(col).updateMany(
        { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
        { $set: { tenantId: targetTenant.id, updatedAt: new Date().toISOString() } }
      );

      if (result.modifiedCount > 0) {
        console.log(`  ${col}: ${result.modifiedCount} atualizados`);
      }
    }

    console.log('Depois da migracao:');
    for (const col of COLLECTIONS_TO_MIGRATE) {
      const countWithTenant = await db.collection(col).countDocuments({ tenantId: { $exists: true, $ne: null } });
      console.log(`  ${col}: ${countWithTenant} com tenantId`);
    }

    await client.close();
    console.log('Migracao concluida com sucesso.');
  } catch (error) {
    console.error('Erro na migracao:', error.message);
    process.exit(1);
  }
}

migrateTenantId();


