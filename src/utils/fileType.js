/**
 * Magic-byte based MIME detection.
 *
 * Looks at the first bytes of a buffer to identify the real file type, rather
 * than trusting the `mimeType` field sent by the client. Used by the media
 * upload route to refuse SVG/HTML/JS files masquerading as images.
 *
 * Returns the detected MIME or null when the buffer doesn't match any known
 * signature. The list is restricted to types we actually accept as message
 * attachments (image, audio, video, pdf). Anything else is rejected upstream.
 */

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf'
]);

const startsWith = (buf, signature, offset = 0) => {
  if (!buf || buf.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[offset + i] !== signature[i]) return false;
  }
  return true;
};

const containsAt = (buf, ascii, offset) => {
  const bytes = Buffer.from(ascii);
  return startsWith(buf, bytes, offset);
};

export const detectMime = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;

  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // GIF87a / GIF89a
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // WebP: 'RIFF' .... 'WEBP'
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && containsAt(buf, 'WEBP', 8)) return 'image/webp';
  // WAV: 'RIFF' .... 'WAVE'
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && containsAt(buf, 'WAVE', 8)) return 'audio/wav';
  // PDF: %PDF-
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // OGG: OggS
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  // MP3 ID3 tag
  if (startsWith(buf, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  // MP3 frame sync (0xFF Ex)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  // ISO BMFF (mp4/quicktime/webm): bytes 4-8 == 'ftyp' or 'moov' for mp4; 'ftyp...qt  ' for mov
  if (containsAt(buf, 'ftyp', 4)) {
    const brand = buf.slice(8, 12).toString('ascii').trim();
    if (brand === 'qt') return 'video/quicktime';
    if (brand === 'isom' || brand === 'iso2' || brand === 'mp42' || brand === 'mp41' || brand === 'avc1' || brand === 'M4V' || brand === 'M4A' || brand === 'mp4 ') {
      return 'video/mp4';
    }
    // unknown brand but ftyp is present — fall back to mp4
    return 'video/mp4';
  }
  // Matroska / WebM: 1A 45 DF A3
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Distinguir webm de mkv exigiria parsing do EBML; aceitamos como webm.
    return 'video/webm';
  }

  return null;
};

/**
 * Validates a buffer against a declared MIME. Returns
 * `{ ok: true, detected }` when accepted, `{ ok: false, reason }` otherwise.
 *
 * The detected type must be in the allow-list. The declared MIME (from the
 * client) must match the detected one — this blocks attackers who try to
 * upload an SVG with `mimeType: image/png`.
 */
export const validateUpload = (buf, declaredMime) => {
  const detected = detectMime(buf);
  if (!detected) {
    return { ok: false, reason: 'Tipo de arquivo não reconhecido' };
  }
  if (!ALLOWED_MIMES.has(detected)) {
    return { ok: false, reason: `Tipo de arquivo não permitido: ${detected}` };
  }
  const normalizedDeclared = String(declaredMime || '').toLowerCase().split(';')[0].trim();
  if (normalizedDeclared && normalizedDeclared !== detected) {
    // Toleramos algumas equivalências comuns (jpg/jpeg)
    const aliases = {
      'image/jpg': 'image/jpeg',
      'audio/mp3': 'audio/mpeg',
      'video/quicktime': 'video/quicktime'
    };
    const aliased = aliases[normalizedDeclared] || normalizedDeclared;
    if (aliased !== detected) {
      return { ok: false, reason: `MIME declarado (${normalizedDeclared}) não bate com o conteúdo (${detected})` };
    }
  }
  return { ok: true, detected };
};

export const isInlineSafeMime = (mime) => (
  mime === 'image/jpeg'
  || mime === 'image/png'
  || mime === 'image/webp'
  || mime === 'image/gif'
);

export const ALLOWED_UPLOAD_MIMES = ALLOWED_MIMES;
