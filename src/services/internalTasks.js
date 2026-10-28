import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { withLock } from './chatLocks.js';

const collection = 'internalTasks';
const managers = ['ADMIN', 'SUPER_ADMIN'];
const readers = [...managers, 'MANAGER', 'AGENT'];
const idSchema = z.string().trim().min(1).max(160);
const statuses = ['pending', 'in_progress', 'completed', 'cancelled'];
const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12000).default(''),
  assignedTo: idSchema.nullable().default(null),
  queueId: idSchema.nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null)
}).strict().refine((input) => Boolean(input.assignedTo) !== Boolean(input.queueId), {
  message: 'Informe um agente ou uma fila, nunca ambos.'
});
const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(statuses).optional()
});
const summary = Object.fromEntries([
  'id', 'tenantId', 'title', 'status', 'priority', 'assignedTo', 'queueId',
  'dueAt', 'createdBy', 'createdAt', 'updatedAt', 'version'
].map((key) => [key, 1]));
const detail = { ...summary, description: 1, claimedAt: 1, completedAt: 1, cancelledAt: 1, updatedBy: 1 };

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'Dados da tarefa invalidos.');
  return result.data;
}

function context({ tenantId, user } = {}) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) fail(400, 'Selecione um tenant.');
  if (!user?.id || !readers.includes(user.role)) fail(403, 'Acesso negado.');
  if (user.role !== 'SUPER_ADMIN' && user.tenantId !== tenantId) fail(403, 'Acesso negado.');
}

// Tasks are independent of chat state and never send messages to a channel.
export function createInternalTaskService(db = adapter, lock = withLock) {
  async function visibility(ctx) {
    context(ctx);
    if (ctx.user.role !== 'AGENT') return { tenantId: ctx.tenantId };
    const queues = await db.findMany('queues', {
      query: { tenantId: ctx.tenantId, active: { $ne: false }, name: { $in: ctx.user.queues || [] } },
      projection: { id: 1, _id: 0 }
    });
    return {
      tenantId: ctx.tenantId,
      $or: [
        { assignedTo: ctx.user.id },
        { assignedTo: null, status: 'pending', queueId: { $in: queues.map((queue) => queue.id) } }
      ]
    };
  }

  async function get(ctx, id) {
    const query = await visibility(ctx);
    const task = await db.findOne(collection, { ...query, id: parse(idSchema, id) }, { projection: { ...detail, _id: 0 } });
    if (!task) fail(404, 'Tarefa nao encontrada.');
    return task;
  }

  return {
    get,
    async create(ctx, input) {
      context(ctx);
      if (!managers.includes(ctx.user.role)) fail(403, 'Somente administradores podem criar tarefas.');
      const data = parse(createSchema, input);
      if (data.assignedTo) {
        const agent = await db.findOne('users', { id: data.assignedTo, tenantId: ctx.tenantId, role: 'AGENT' }, { projection: { id: 1 } });
        if (!agent) fail(400, 'Agente invalido para este tenant.');
      } else {
        const queue = await db.findOne('queues', { id: data.queueId, tenantId: ctx.tenantId, active: { $ne: false } }, { projection: { id: 1 } });
        if (!queue) fail(400, 'Fila invalida para este tenant.');
      }
      const now = new Date().toISOString();
      const task = {
        ...data, id: `task_${randomUUID()}`, tenantId: ctx.tenantId,
        status: 'pending', version: 1, createdBy: ctx.user.id, updatedBy: ctx.user.id,
        createdAt: now, updatedAt: now, claimedAt: null, completedAt: null, cancelledAt: null
      };
      await db.insertOne(collection, task);
      return get(ctx, task.id);
    },
    async list(ctx, input = {}) {
      const query = await visibility(ctx);
      const { page, limit, status } = parse(listSchema, input);
      if (status) query.status = status;
      const [items, total] = await Promise.all([
        db.findMany(collection, { query, projection: { ...summary, _id: 0 }, sort: { createdAt: -1, id: -1 }, skip: (page - 1) * limit, limit }),
        db.countDocuments(collection, query)
      ]);
      return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    },
    async transition(ctx, id, input) {
      context(ctx);
      parse(idSchema, id);
      const { action, version } = parse(z.object({
        action: z.enum(['claim', 'complete', 'cancel']), version: z.number().int().positive()
      }).strict(), input);
      if (ctx.user.role === 'MANAGER') fail(403, 'Perfil somente leitura.');
      return lock(`internal-task:${ctx.tenantId}:${id}`, async () => {
        const task = await get(ctx, id);
        if (task.version !== version) fail(409, 'Tarefa alterada. Atualize antes de continuar.');
        const now = new Date().toISOString();
        const changes = { version: version + 1, updatedAt: now, updatedBy: ctx.user.id };
        if (action === 'claim') {
          if (ctx.user.role !== 'AGENT') fail(403, 'Somente agentes podem assumir tarefas.');
          if (task.status !== 'pending') fail(409, 'Tarefa nao esta pendente.');
          changes.status = 'in_progress';
          changes.assignedTo = ctx.user.id;
          changes.claimedAt = now;
        } else if (action === 'complete') {
          if (task.status !== 'in_progress') fail(409, 'Assuma a tarefa antes de concluir.');
          if (ctx.user.role === 'AGENT' && task.assignedTo !== ctx.user.id) fail(403, 'Acesso negado.');
          changes.status = 'completed';
          changes.completedAt = now;
        } else {
          if (!managers.includes(ctx.user.role)) fail(403, 'Somente administradores podem cancelar tarefas.');
          if (!['pending', 'in_progress'].includes(task.status)) fail(409, 'Tarefa ja finalizada.');
          changes.status = 'cancelled';
          changes.cancelledAt = now;
        }
        // Database CAS complements the process/distributed lock across workers.
        const result = await db.updateOne(collection,
          { tenantId: ctx.tenantId, id, version, status: task.status, assignedTo: task.assignedTo },
          { $set: changes }
        );
        if (result.matchedCount !== 1) fail(409, 'Tarefa alterada. Atualize antes de continuar.');
        return get(ctx, id);
      });
    }
  };
}

export const internalTasks = createInternalTaskService();
