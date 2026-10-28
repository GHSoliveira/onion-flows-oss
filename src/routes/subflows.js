import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { createLog } from '../services/logs.js';
import { generateId } from '../utils/helpers.js';
import {
  findSubflowUsage,
  getSubflowById,
  invalidateSubflowCache,
  listSubflows,
  validateSubflowGraph
} from '../services/subflows.js';

const router = express.Router();
const READ_ROLES = ['ADMIN', 'MANAGER', 'SUPER_ADMIN'];
const WRITE_ROLES = ['ADMIN', 'SUPER_ADMIN'];

const snapshotOf = (source = {}) => ({
  nodes: Array.isArray(source.nodes) ? JSON.parse(JSON.stringify(source.nodes)) : [],
  edges: Array.isArray(source.edges) ? JSON.parse(JSON.stringify(source.edges)) : [],
  visualBlocks: Array.isArray(source.visualBlocks) ? JSON.parse(JSON.stringify(source.visualBlocks)) : []
});

// O grafo inicial ja vem com entrada e saida: sao fixos e o editor nao permite
// criar nem remover, entao precisam existir desde o primeiro save.
// O id da entrada precisa ser 'start': o editor normaliza o grafo procurando
// exatamente esse id e, se nao achar, cria outro startNode (duplicando a entrada).
const initialGraph = () => ({
  nodes: [
    { id: 'start', type: 'startNode', position: { x: 120, y: 240 }, data: { label: 'Entrada', text: 'Entrada' } },
    { id: 'sub_return', type: 'subflowReturnNode', position: { x: 940, y: 240 }, data: { label: 'Saida' } }
  ],
  edges: [],
  visualBlocks: []
});

router.get('/', authenticate, authorize(READ_ROLES, { permission: 'fluxos.ver' }), requireTenant, async (req, res) => {
  try {
    const items = await listSubflows(req.tenantId);
    res.json(items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
      status: item.status || 'draft',
      version: item.version || 1,
      nodeCount: Array.isArray(item.draft?.nodes) ? item.draft.nodes.length : 0,
      updatedAt: item.updatedAt || null,
      publishedAt: item.published?.publishedAt || null
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authenticate, authorize(READ_ROLES, { permission: 'fluxos.ver' }), requireTenant, async (req, res) => {
  try {
    const subflow = await getSubflowById(req.tenantId, req.params.id);
    if (!subflow) return res.status(404).json({ error: 'Subfluxo nao encontrado' });
    res.json(subflow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Onde o subfluxo e usado. O modal de detalhes mostra isso antes de deixar
// editar, porque alterar afeta todos os fluxos da lista.
router.get('/:id/usage', authenticate, authorize(READ_ROLES, { permission: 'fluxos.ver' }), requireTenant, async (req, res) => {
  try {
    res.json({ usage: await findSubflowUsage(req.tenantId, req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(WRITE_ROLES, { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });

    const now = new Date().toISOString();
    const subflow = {
      id: generateId('sub'),
      tenantId: req.tenantId,
      name,
      description: String(req.body?.description || '').trim(),
      status: 'draft',
      version: 1,
      draft: initialGraph(),
      published: null,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.id || 'system'
    };

    await adapter.saveDocument('subflows', subflow);
    invalidateSubflowCache(req.tenantId);
    await createLog('SUBFLOW_CREATE', { tenantId: req.tenantId, subflowId: subflow.id, name }, req.user.id);
    res.status(201).json(subflow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(WRITE_ROLES, { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    const subflow = await getSubflowById(req.tenantId, req.params.id);
    if (!subflow) return res.status(404).json({ error: 'Subfluxo nao encontrado' });

    const { nodes, edges, visualBlocks, name, description, publish } = req.body || {};
    const hasGraph = Array.isArray(nodes) && Array.isArray(edges);
    const now = new Date().toISOString();

    const updated = {
      ...subflow,
      name: typeof name === 'string' && name.trim() ? name.trim() : subflow.name,
      description: typeof description === 'string' ? description : subflow.description,
      updatedAt: now
    };

    if (hasGraph) {
      updated.draft = snapshotOf({ nodes, edges, visualBlocks });
      updated.version = (subflow.version || 0) + 1;
    }

    if (publish) {
      if (!hasGraph) return res.status(400).json({ error: 'Publicacao exige nodes e edges' });
      // Publicar valida de verdade: a versao publicada e a que roda em producao
      // dentro dos fluxos que referenciam este subfluxo.
      const problems = validateSubflowGraph({ nodes, edges });
      if (problems.length) {
        return res.status(400).json({ error: 'O subfluxo tem problemas que impedem a publicacao.', problems });
      }
      updated.published = { ...snapshotOf({ nodes, edges, visualBlocks }), publishedAt: now, version: updated.version };
      updated.status = 'published';
    }

    await adapter.saveDocument('subflows', updated);
    invalidateSubflowCache(req.tenantId, updated.id);
    await createLog('SUBFLOW_UPDATE', {
      tenantId: req.tenantId, subflowId: updated.id, published: Boolean(publish)
    }, req.user.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(WRITE_ROLES, { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    const subflow = await getSubflowById(req.tenantId, req.params.id);
    if (!subflow) return res.status(404).json({ error: 'Subfluxo nao encontrado' });

    // Apagar um subfluxo em uso derrubaria os fluxos pais na saida de excecao,
    // sem ninguem entender o motivo. Bloqueia e mostra onde ele e usado.
    const usage = await findSubflowUsage(req.tenantId, req.params.id);
    if (usage.length) {
      return res.status(409).json({
        error: `Este subfluxo e usado em ${usage.length} fluxo(s). Remova as referencias antes de excluir.`,
        code: 'subflow_in_use',
        usage
      });
    }

    await adapter.deleteMany('subflows', { tenantId: req.tenantId, id: req.params.id });
    invalidateSubflowCache(req.tenantId, req.params.id);
    await createLog('SUBFLOW_DELETE', { tenantId: req.tenantId, subflowId: req.params.id }, req.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
