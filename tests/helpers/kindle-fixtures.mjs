// 按 Palm 数据库记录目录、PalmDOC、MOBI 与 EXTH 的真实布局构造样本。
export const kindleCover = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6l8AAAAASUVORK5CYII=', 'base64'
));

const encode = (value, encoding) => encoding === 1252
  ? Uint8Array.from([...value].map((char) => char.codePointAt(0)))
  : new TextEncoder().encode(value);

export function numberRecord(type, value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return { type, bytes };
}

export function kindleHeader({
  title = '正确的中文书名', author = '测试作者', pdbTitle = 'Internal_database_name',
  fullTitle = '完整书名', encoding = 65001, version = 6, firstImage = 2,
  coverOffset = 1, encryption = 0, extraRecords = [], includeExth = true,
} = {}) {
  const headerLength = version === 8 ? 264 : 232;
  const fields = [
    { type: 503, bytes: encode(title, encoding) },
    { type: 100, bytes: encode(author, encoding) },
    { type: 101, bytes: encode('测试出版社', encoding) },
    { type: 103, bytes: encode('测试简介', encoding) },
    { type: 104, bytes: encode('9781234567890', encoding) },
    { type: 524, bytes: encode('zh-CN', encoding) },
    ...(coverOffset == null ? [] : [numberRecord(201, coverOffset)]),
    ...extraRecords,
  ];
  const exthLength = includeExth ? 12 + fields.reduce((size, field) => size + 8 + field.bytes.length, 0) : 0;
  const name = encode(fullTitle, encoding);
  const nameOffset = 16 + headerLength + exthLength;
  const bytes = new Uint8Array(nameOffset + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 2);
  view.setUint16(12, encryption);
  bytes.set(new TextEncoder().encode('MOBI'), 16);
  view.setUint32(20, headerLength);
  view.setUint32(24, 2);
  view.setUint32(28, encoding);
  view.setUint32(36, version);
  view.setUint32(84, nameOffset);
  view.setUint32(88, name.length);
  view.setUint32(92, 0x804);
  view.setUint32(108, firstImage);
  view.setUint32(128, includeExth ? 0x40 : 0);
  if (includeExth) {
    let position = 16 + headerLength;
    bytes.set(new TextEncoder().encode('EXTH'), position);
    view.setUint32(position + 4, exthLength);
    view.setUint32(position + 8, fields.length);
    position += 12;
    for (const field of fields) {
      view.setUint32(position, field.type);
      view.setUint32(position + 4, field.bytes.length + 8);
      bytes.set(field.bytes, position + 8);
      position += field.bytes.length + 8;
    }
  }
  bytes.set(name, nameOffset);
  return { bytes, pdbTitle };
}

export function palmDatabase(records, pdbTitle = 'Internal_database_name', ident = 'BOOKMOBI') {
  const firstOffset = 78 + records.length * 8 + 2;
  const bytes = new Uint8Array(firstOffset + records.reduce((size, record) => size + record.length, 0));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(pdbTitle).subarray(0, 31));
  bytes.set(new TextEncoder().encode(ident), 60);
  view.setUint16(76, records.length);
  let offset = firstOffset;
  records.forEach((record, index) => {
    view.setUint32(78 + index * 8, offset);
    view.setUint32(82 + index * 8, index * 2);
    bytes.set(record, offset);
    offset += record.length;
  });
  return bytes;
}

export function kindleFile(options = {}) {
  const header = kindleHeader(options);
  const records = [header.bytes, new TextEncoder().encode('正文记录'), new Uint8Array([1, 2, 3]), kindleCover];
  return palmDatabase(records, header.pdbTitle, options.ident || 'BOOKMOBI');
}
