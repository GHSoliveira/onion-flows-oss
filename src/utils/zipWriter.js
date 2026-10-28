const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

const dosDateTime = (dateValue = new Date()) => {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.max(1980, safe.getFullYear());
  const dosTime = (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate();
  return { dosTime, dosDate };
};

const writeUInt16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xFFFF, 0);
  return buffer;
};

const writeUInt32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

export const createZipBuffer = (files = []) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();

  (Array.isArray(files) ? files : []).forEach((file) => {
    const name = String(file?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) return;

    const nameBuffer = Buffer.from(name, 'utf8');
    const contentBuffer = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content || ''), 'utf8');
    const checksum = crc32(contentBuffer);
    const { dosTime, dosDate } = dosDateTime(file.modifiedAt || now);
    const size = contentBuffer.length;

    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      nameBuffer
    ]);

    localParts.push(localHeader, contentBuffer);

    const centralHeader = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      nameBuffer
    ]);

    centralParts.push(centralHeader);
    offset += localHeader.length + contentBuffer.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(centralParts.length),
    writeUInt16(centralParts.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(offset),
    writeUInt16(0)
  ]);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
};
