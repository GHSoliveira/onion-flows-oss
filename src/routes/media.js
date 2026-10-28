import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { generateId } from '../utils/helpers.js';
import { validateUpload } from '../utils/fileType.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.resolve(__dirname, '../../uploads');
const DEFAULT_MAX_UPLOAD_BYTES = 70 * 1024 * 1024;
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MEDIA_MAX_UPLOAD_BYTES || `${DEFAULT_MAX_UPLOAD_BYTES}`, 10);

const sanitizeFilename = (name) => String(name || 'arquivo')
  .replace(/[^\p{L}\p{N}._-]/gu, '_')
  .slice(0, 120);

const normalizeMimeType = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .split(';')[0]
  .trim();

const getExtension = (filename, mimeType) => {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext) return ext;
  const normalizedMime = normalizeMimeType(mimeType);
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf'
  };
  return map[normalizedMime] || '';
};

const parseDataUrl = (value) => {
  const source = String(value || '');
  const match = source.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2]
  };
};

const resolvePublicUrl = (req, tenantId, fileName) => {
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim();
  const base = publicBase || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${encodeURIComponent(tenantId)}/${encodeURIComponent(fileName)}`;
};

router.get('/assets', authenticate, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const q = String(req.query.q || '').trim().toLowerCase();
    const type = String(req.query.type || '').trim().toLowerCase();
    const all = await adapter.getCollection('mediaAssets', tenantId);
    let items = Array.isArray(all) ? all : [];

    if (type) {
      items = items.filter((item) => String(item.mimeType || '').toLowerCase().startsWith(type));
    }
    if (q) {
      items = items.filter((item) => {
        const haystack = [
          item.originalName,
          item.fileName,
          item.mimeType
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/assets', authenticate, authorize(['ADMIN', 'SUPER_ADMIN', 'AGENT'], { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const originalName = sanitizeFilename(req.body?.filename || 'arquivo');
    const parsed = parseDataUrl(req.body?.dataUrl);
    const mimeType = normalizeMimeType(req.body?.mimeType || parsed?.mimeType || '');

    if (!parsed?.base64) {
      return res.status(400).json({ error: 'dataUrl base64 obrigatorio' });
    }
    if (!mimeType) {
      return res.status(400).json({ error: 'mimeType obrigatorio' });
    }

    const buffer = Buffer.from(parsed.base64, 'base64');
    if (!buffer.length) {
      return res.status(400).json({ error: 'Arquivo vazio' });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Arquivo excede limite de ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` });
    }

    // Magic-byte validation: confirma que o conteúdo bate com o MIME declarado
    // e que o tipo está na lista de permitidos. Impede SVG/HTML/JS travestidos
    // de imagem (com payload XSS).
    const validation = validateUpload(buffer, mimeType);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason });
    }
    const verifiedMime = validation.detected;

    const extension = getExtension(originalName, verifiedMime);
    const fileName = `${generateId('media')}${extension}`;
    const safeTenantId = String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '');
    const tenantDir = path.join(uploadsRoot, safeTenantId);
    const filePath = path.resolve(tenantDir, fileName);
    if (!filePath.startsWith(path.resolve(uploadsRoot))) {
      return res.status(400).json({ error: 'Path inválido' });
    }

    await fs.mkdir(tenantDir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    const asset = {
      id: generateId('asset'),
      tenantId,
      fileName,
      originalName,
      mimeType: verifiedMime,
      size: buffer.length,
      url: resolvePublicUrl(req, tenantId, fileName),
      createdAt: new Date().toISOString(),
      createdBy: req.user?.id || null
    };

    if (!adapter.db) await adapter.init();
    await adapter.db.collection('mediaAssets').insertOne(asset);
    res.status(201).json(asset);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/assets/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('mediaAssets');
    const query = { id: req.params.id, tenantId };
    const asset = await collection.findOne(query);
    if (!asset) {
      return res.status(404).json({ error: 'Arquivo nao encontrado' });
    }

    const filePath = path.join(uploadsRoot, tenantId, asset.fileName || '');
    await fs.unlink(filePath).catch(() => {});
    await collection.deleteOne(query);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
