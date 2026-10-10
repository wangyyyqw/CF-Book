// Kindle 元数据与封面只按 PDB 记录精读，不解压正文，也不整读大文件。
const NO_INDEX = 0xffffffff;
const MAX_HEADER = 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const magic = (bytes, offset, text) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

function fileSize(file) {
  return file.size ?? file.byteLength;
}

async function readRange(file, start, end) {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  return bytes.subarray(start, end);
}

async function recordTable(file) {
  const size = fileSize(file);
  if (!Number.isSafeInteger(size) || size < 86) return null;
  const head = await readRange(file, 0, 78);
  if (head.length !== 78 || (!magic(head, 60, 'BOOKMOBI') && !magic(head, 60, 'TEXTREAD'))) return null;
  const count = viewOf(head).getUint16(76);
  const end = 78 + count * 8;
  if (!count || end > size) return null;
  const bytes = await readRange(file, 78, end);
  if (bytes.length !== count * 8) return null;
  const view = viewOf(bytes);
  const offsets = Array.from({ length: count }, (_, i) => view.getUint32(i * 8));
  if (offsets.some((offset, i) => offset < end || offset >= size || (i > 0 && offset <= offsets[i - 1]))) return null;
  offsets.push(size);
  return offsets;
}

async function readRecord(file, offsets, index, limit) {
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length - 1) return null;
  const start = offsets[index];
  const length = offsets[index + 1] - start;
  if (length > limit) return null;
  const bytes = await readRange(file, start, start + length);
  return bytes.length === length ? bytes : null;
}

function exthRecords(bytes, start) {
  const empty = { fields: new Map(), warning: 'EXTH 元数据损坏，已忽略无效字段' };
  if (start + 12 > bytes.length || !magic(bytes, start, 'EXTH')) return empty;
  const view = viewOf(bytes);
  const end = start + view.getUint32(start + 4);
  const count = view.getUint32(start + 8);
  if (end < start + 12 || end > bytes.length || count > (end - start - 12) / 8) return empty;
  const fields = new Map();
  let position = start + 12;
  for (let i = 0; i < count; i += 1) {
    if (position + 8 > end) return empty;
    const type = view.getUint32(position);
    const length = view.getUint32(position + 4);
    if (length < 8 || position + length > end) return empty;
    const values = fields.get(type) || [];
    values.push(bytes.subarray(position + 8, position + length));
    fields.set(type, values);
    position += length;
  }
  return { fields, warning: '' };
}

function decodeText(bytes, decoder) {
  if (!decoder || !bytes?.length) return '';
  try {
    const text = decoder.decode(bytes).replace(/\0+$/, '').trim();
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd]/.test(text) ? '' : text;
  } catch {
    return '';
  }
}

function numberField(fields, type) {
  const bytes = fields.get(type)?.[0];
  return bytes?.length === 4 ? viewOf(bytes).getUint32(0) : NO_INDEX;
}

function metadataFields(bytes, fields, decoder) {
  const text = (type) => (fields.get(type) || []).map((value) => decodeText(value, decoder)).filter(Boolean);
  const view = viewOf(bytes);
  const start = view.getUint32(84);
  const length = view.getUint32(88);
  const fullTitle = start >= 16 + view.getUint32(20) && start + length <= bytes.length
    ? decodeText(bytes.subarray(start, start + length), decoder) : '';
  const title = text(503).at(-1) || fullTitle;
  const locales = { 0x804: 'zh-CN', 0x404: 'zh-TW', 0x409: 'en-US', 0x809: 'en-GB', 0x411: 'ja', 0x412: 'ko' };
  return {
    title,
    author: text(100).join('、'),
    publisher: text(101)[0] || '',
    description: text(103)[0] || '',
    isbn: text(104)[0] || '',
    date: (text(106)[0] || '').slice(0, 10),
    language: text(524)[0] || locales[view.getUint32(92)] || '',
  };
}

function parseHeader(bytes) {
  if (!bytes || bytes.length < 132 || !magic(bytes, 16, 'MOBI')) return null;
  const view = viewOf(bytes);
  const length = view.getUint32(20);
  if (length < 116 || 16 + length > bytes.length) return null;
  const encoding = view.getUint32(28);
  const codec = { 65001: 'utf-8', 1252: 'windows-1252' }[encoding];
  const decoder = codec ? new TextDecoder(codec, { fatal: true }) : null;
  const exth = view.getUint32(128) & 0x40
    ? exthRecords(bytes, 16 + length) : { fields: new Map(), warning: '' };
  return {
    meta: metadataFields(bytes, exth.fields, decoder),
    version: view.getUint32(36),
    textRecords: view.getUint16(8),
    firstImage: view.getUint32(108),
    coverOffset: numberField(exth.fields, 201),
    kf8Index: numberField(exth.fields, 121),
    encrypted: view.getUint16(12) !== 0,
    warning: [exth.warning, !codec ? `不支持的 Kindle 文本编码 ${encoding}，已回退文件名` : ''].filter(Boolean).join('；'),
  };
}

async function kindleContext(file) {
  const offsets = await recordTable(file);
  if (!offsets) return null;
  const legacy = parseHeader(await readRecord(file, offsets, 0, MAX_HEADER));
  if (!legacy) return null;
  const index = legacy.kf8Index;
  let modern = null;
  if (legacy.version !== 8 && index > 1 && index < offsets.length - 1) {
    const boundary = await readRecord(file, offsets, index - 1, 8);
    if (boundary?.length === 8 && magic(boundary, 0, 'BOUNDARY')) {
      modern = parseHeader(await readRecord(file, offsets, index, MAX_HEADER));
      if (modern?.version !== 8) modern = null;
    }
  }
  return { offsets, legacy, modern, header: modern || legacy, index };
}

function resourceStart(header, base) {
  return header.firstImage === NO_INDEX
    ? base + 1 + header.textRecords : base + header.firstImage;
}

function coverIndex(context) {
  const { header, legacy, modern, index, offsets } = context;
  const offset = header.coverOffset;
  if (offset === NO_INDEX) return -1;
  if (!modern) {
    const result = resourceStart(header, 0) + offset;
    return result < offsets.length - 1 ? result : -1;
  }

  // KF8 的资源映射先遍历 MOBI7 资源区，再遍历 BOUNDARY 后的 KF8 资源区。
  const sharedStart = resourceStart(legacy, 0);
  const legacyEnd = index - 1;
  const modernStart = resourceStart(header, index);
  const sharedCount = Math.max(0, legacyEnd - sharedStart);
  if (offset < sharedCount) return sharedStart + offset;
  const result = modernStart + offset - sharedCount;
  return result >= index + 1 && result < offsets.length - 1 ? result : -1;
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && magic(bytes, 1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (magic(bytes, 0, 'GIF87a') || magic(bytes, 0, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && magic(bytes, 0, 'RIFF') && magic(bytes, 8, 'WEBP')) return 'image/webp';
  return '';
}

export async function readKindleMetadata(file) {
  const context = await kindleContext(file);
  if (!context) return { warning: '无法读取 Kindle 元数据，已使用文件名；可在入库后手动修改' };
  const { header, legacy, modern } = context;
  const encrypted = legacy.encrypted || modern?.encrypted || false;
  const warning = [
    header.warning,
    !header.meta.title ? '文件没有可用的完整书名，已使用文件名' : '',
    encrypted ? '文件含 DRM 加密，仅读取公开元数据，不提取受保护封面' : '',
  ].filter(Boolean).join('；');
  return { ...header.meta, encrypted, warning };
}

export async function readKindleCover(file) {
  const context = await kindleContext(file);
  if (!context || context.legacy.encrypted || context.modern?.encrypted) return null;
  const index = coverIndex(context);
  const bytes = await readRecord(file, context.offsets, index, MAX_COVER);
  const mime = bytes ? imageMime(bytes) : '';
  return mime ? { bytes, mime } : null;
}
