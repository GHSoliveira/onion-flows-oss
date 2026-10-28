import bcrypt from 'bcrypt';
import adapter from '../db/DatabaseAdapter.js';

const now = () => new Date().toISOString();

const upsert = async (collection, id, doc) => {
  await adapter.db.collection(collection).updateOne(
    { id },
    { $set: doc },
    { upsert: true }
  );
};

const main = async () => {
  if (String(process.env.DB_ADAPTER || '').toLowerCase() !== 'json' && process.env.USE_JSON_DB !== 'true') {
    throw new Error('Seed sandbox abortado: DB_ADAPTER=json nao esta ativo.');
  }

  await adapter.init();

  const adminUsername = process.env.SANDBOX_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.SANDBOX_ADMIN_PASSWORD || 'sandbox123';
  const agentUsername = process.env.SANDBOX_AGENT_USERNAME || 'agent';
  const agentPassword = process.env.SANDBOX_AGENT_PASSWORD || 'sandbox123';
  const timestamp = now();

  const tenant = {
    id: 'tenant_sandbox',
    name: 'Tenant Sandbox',
    slug: 'sandbox',
    plan: 'sandbox',
    status: 'active',
    settings: {
      maxUsers: 50,
      maxFlows: 100,
      maxChatsPerDay: 10000
    },
    billing: {
      paymentStatus: 'paid',
      blocked: false
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const queue = {
    id: 'queue_sandbox_atendimento',
    tenantId: tenant.id,
    name: 'ATENDIMENTO',
    description: 'Fila padrao do sandbox',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const flow = {
    id: 'f_sandbox_whatsapp',
    tenantId: tenant.id,
    name: 'Fluxo Sandbox WhatsApp',
    description: 'Fluxo simples para o simulador C#',
    status: 'published',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'u_sandbox_superadmin',
    version: 1,
    draft: null,
    published: {
      version: 1,
      publishedAt: timestamp,
      nodes: [
        {
          id: 'start',
          type: 'startNode',
          position: { x: 0, y: 0 },
          data: { label: '', text: '' }
        },
        {
          id: 'msg_sandbox_welcome',
          type: 'messageNode',
          position: { x: 233, y: 0 },
          data: {
            text: 'Ola! Vou te encaminhar para o agente sandbox agora.',
            conditions: [],
            mappings: [],
            customName: 'Boas-vindas'
          }
        },
        {
          id: 'queue_sandbox_agent',
          type: 'queueNode',
          position: { x: 559, y: 0 },
          data: {
            queueName: 'ATENDIMENTO',
            queueMessage: 'Aguarde, o agente sandbox vai te atender.',
            continueAfterAgent: false,
            conditions: [],
            mappings: [],
            customName: 'Fila sandbox'
          }
        }
      ],
      edges: [
        { id: 'e_start_welcome', source: 'start', sourceHandle: 'default', target: 'msg_sandbox_welcome' },
        { id: 'e_welcome_queue', source: 'msg_sandbox_welcome', sourceHandle: 'default', target: 'queue_sandbox_agent' }
      ],
      visualBlocks: []
    },
    publishHistory: [],
    nodes: [],
    edges: [],
    visualBlocks: []
  };

  const channelConfig = {
    id: 'channel_config_sandbox',
    tenantId: tenant.id,
    whatsapp: {
      enabled: true,
      accessToken: 'sandbox_fake_access_token',
      phoneNumberId: 'sandbox_phone_001',
      wabaId: 'sandbox_waba',
      flowId: flow.id,
      webhookVerifyToken: 'sandbox_verify_token',
      appSecret: 'sandbox_whatsapp_secret',
      senderNumbers: [
        {
          id: 'wa_sender_sandbox_phone_001',
          label: 'Sandbox WhatsApp',
          displayNumber: '+55 11 99999-0000',
          phoneNumberId: 'sandbox_phone_001',
          flowId: flow.id,
          enabled: true,
          isDefault: true
        }
      ],
      updatedAt: timestamp
    },
    telegram: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const admin = {
    id: 'u_sandbox_superadmin',
    name: 'Sandbox Super Admin',
    username: adminUsername,
    password: await bcrypt.hash(adminPassword, 10),
    role: 'SUPER_ADMIN',
    queues: [],
    permissions: ['*'],
    tenantId: null,
    status: 'offline',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const tenantAdmin = {
    id: 'u_sandbox_admin',
    name: 'Sandbox Admin',
    username: 'tenantadmin',
    password: await bcrypt.hash(adminPassword, 10),
    role: 'ADMIN',
    queues: ['ATENDIMENTO'],
    permissions: [],
    tenantId: tenant.id,
    status: 'offline',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const agent = {
    id: 'u_sandbox_agent',
    name: 'Sandbox Agent',
    username: agentUsername,
    password: await bcrypt.hash(agentPassword, 10),
    role: 'AGENT',
    queues: ['ATENDIMENTO'],
    permissions: [],
    tenantId: tenant.id,
    status: 'offline',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await upsert('tenants', tenant.id, tenant);
  await upsert('queues', queue.id, queue);
  await upsert('flows', flow.id, flow);
  await upsert('channelConfigs', channelConfig.id, channelConfig);
  await upsert('users', admin.id, admin);
  await upsert('users', tenantAdmin.id, tenantAdmin);
  await upsert('users', agent.id, agent);

  console.log('[SANDBOX] Seed JSON pronto');
  console.log(`[SANDBOX] Super admin: ${adminUsername} / ${adminPassword}`);
  console.log(`[SANDBOX] Agent: ${agentUsername} / ${agentPassword}`);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[SANDBOX] Falha no seed:', error.message);
    process.exit(1);
  });
