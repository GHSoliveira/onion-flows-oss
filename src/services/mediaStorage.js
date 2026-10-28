import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.resolve(__dirname, '../../uploads');

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
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'application/pdf': '.pdf'
  };
  return map[normalizedMime] || '';
};

export const storeTenantMediaBuffer = async ({
  tenantId,
  buffer,
  mimeType = '',
  originalName = 'arquivo',
  prefix = 'media'
}) => {
  if (!tenantId) {
    throw new Error('tenantId obrigatorio para armazenar midia');
  }
  if (!buffer || !buffer.length) {
    throw new Error('buffer obrigatorio para armazenar midia');
  }

  const safeOriginalName = sanitizeFilename(originalName);
  const extension = getExtension(safeOriginalName, mimeType);
  const fileName = `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}${extension}`;
  const tenantDir = path.join(uploadsRoot, tenantId);
  const filePath = path.join(tenantDir, fileName);

  await fs.mkdir(tenantDir, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    originalName: safeOriginalName,
    mimeType: normalizeMimeType(mimeType) || null,
    size: buffer.length,
    url: `/uploads/${encodeURIComponent(tenantId)}/${encodeURIComponent(fileName)}`
  };
};
