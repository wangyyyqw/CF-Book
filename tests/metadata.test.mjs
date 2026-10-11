import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../public/vendor/fflate.js';
import { extractCoverFromFile, extractFileMetadata } from '../public/metadata.js';
import { kindleFile, kindleHeader, palmDatabase, kindleCover, numberRecord } from './helpers/kindle-fixtures.mjs';

function epubWithExternalCover() {
  const files = {
    mimetype: new Uint8Array(strToU8('application/epub+zip')),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package><metadata><dc:title xmlns:dc="x">测试书</dc:title></metadata><manifest></manifest></package>'
    ),
    'OEBPS/Text/cover.xhtml': strToU8(
      '<html><body><img alt="封面" src="https://example.com/covers/test.jpg?x=1&amp;y=2"/></body></html>'
    ),
  };
  return new File([zipSync(files)], 'test.epub');
}

test('EPUB 没有 OPF 封面声明时，可从 cover.xhtml 识别外链封面', async () => {
  const cover = await extractCoverFromFile(epubWithExternalCover(), 'test.epub');
  assert.deepEqual(cover, { url: 'https://example.com/covers/test.jpg?x=1&y=2' });
});

test('ZIP 条目使用 data descriptor 时仍能读取封面页', async () => {
  // 真实微信读书 EPUB 的 local header 大小为 0，大小只在中央目录中有效。
  const cover = await extractCoverFromFile(epubWithExternalCover(), 'test.epub');
  assert.equal(cover?.url, 'https://example.com/covers/test.jpg?x=1&y=2');
});

test('封面 href 的 URI 编码解码后匹配 ZIP 条目', async () => {
  const expected = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const files = {
    mimetype: new Uint8Array(strToU8('application/epub+zip')),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package><metadata></metadata><manifest><item id="cover" href="Images/Cover%20Art%2A.jpg?download=1" media-type="image/jpeg"/></manifest><meta name="cover" content="cover"/></package>'
    ),
    'OEBPS/Images/Cover Art*.jpg': expected,
  };
  const cover = await extractCoverFromFile(new File([zipSync(files)], 'encoded-cover.epub'), 'encoded-cover.epub');
  assert.equal(cover?.mime, 'image/jpeg');
  assert.deepEqual(cover?.bytes, expected);
});

test('封面 href 使用 ../ 返回 EPUB 压缩包根目录时仍可提取', async () => {
  const expected = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const files = {
    mimetype: new Uint8Array(strToU8('application/epub+zip')),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package><manifest><item id="cover" href="../cover.jpg?x=1"/></manifest><meta name="cover" content="cover"/></package>'
    ),
    'cover.jpg': expected,
  };
  const cover = await extractCoverFromFile(new File([zipSync(files)], 'parent-cover.epub'), 'parent-cover.epub');
  assert.equal(cover?.mime, 'image/jpeg');
  assert.deepEqual(cover?.bytes, expected);
});

// 多看（Duokan）制作：无 meta cover / 无 properties="cover-image"，封面走 <guide type="cover">，
// 封面图文件名是纯数字，靠文件名回退命不中。
function epubWithGuideCover({ imageName = 'Images/92.jpg', imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), imgSrc } = {}) {
  const files = {
    mimetype: new Uint8Array(strToU8('application/epub+zip')),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package><metadata><dc:title xmlns:dc="x">地铁三部曲</dc:title></metadata>' +
        '<manifest><item id="x_inserted" href="Text/15.xhtml" media-type="application/xhtml+xml"/>' +
        `<item id="coverpage.jpg" href="${imageName}" media-type="image/jpeg"/></manifest>` +
        '<spine><itemref idref="x_inserted"/></spine>' +
        '<guide><reference type="cover" title="Cover" href="Text/15.xhtml"/></guide></package>'
    ),
    'OEBPS/Text/15.xhtml': strToU8(
      `<html><body><img alt="coverpage" src="${imgSrc ?? `../${imageName}`}"/></body></html>`
    ),
    [`OEBPS/${imageName}`]: imageBytes,
  };
  return new File([zipSync(files)], 'duokan.epub');
}

test('多看 EPUB 用 guide type="cover" 声明封面页时，按页面内 img 提取数字文件名封面', async () => {
  const expected = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const cover = await extractCoverFromFile(epubWithGuideCover({ imageBytes: expected }), 'duokan.epub');
  assert.equal(cover?.mime, 'image/jpeg');
  assert.deepEqual(cover?.bytes, expected);
});

test('多看 guide 指向的封面页使用外链图片时返回 url', async () => {
  const cover = await extractCoverFromFile(
    epubWithGuideCover({ imgSrc: 'https://example.com/duokan-cover.jpg?a=1&amp;b=2' }),
    'duokan.epub'
  );
  assert.deepEqual(cover, { url: 'https://example.com/duokan-cover.jpg?a=1&b=2' });
});

test('多看 guide 的 cover 引用可直接指向图片文件', async () => {
  const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const files = {
    mimetype: new Uint8Array(strToU8('application/epub+zip')),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package><manifest><item id="coverpage.jpg" href="Images/92.png" media-type="image/png"/></manifest>' +
        '<guide><reference type="cover" href="Images/92.png"/></guide></package>'
    ),
    'OEBPS/Images/92.png': expected,
  };
  const cover = await extractCoverFromFile(new File([zipSync(files)], 'duokan-img.epub'), 'duokan-img.epub');
  assert.equal(cover?.mime, 'image/png');
  assert.deepEqual(cover?.bytes, expected);
});

test('MOBI 按记录目录定位头部，优先使用 EXTH 的中文书名而非数据库内部名称', async () => {
  const bytes = kindleFile();
  const meta = await extractFileMetadata(new File([bytes], '错误文件名.mobi'), '错误文件名.mobi');
  assert.equal(meta.title, '正确的中文书名');
  assert.equal(meta.author, '测试作者');
  assert.equal(meta.publisher, '测试出版社');
  assert.equal(meta.description, '测试简介');
  assert.equal(meta.language, 'zh-CN');
  assert.equal(meta.isbn, '9781234567890');
  assert.equal((await extractFileMetadata(bytes, 'wrong.mobi')).title, meta.title);
});

test('没有 EXTH 更新书名时读取完整书名，不采用截断的 PDB 名称', async () => {
  const bytes = kindleFile({ title: '', fullTitle: '超过三十二字节的完整中文书名也不能被截断' });
  const meta = await extractFileMetadata(bytes, 'wrong.mobi');
  assert.equal(meta.title, '超过三十二字节的完整中文书名也不能被截断');
});

test('MOBI 元数据遵循 Windows-1252 编码而非强行 UTF-8', async () => {
  const bytes = kindleFile({ title: 'Café', author: 'André', encoding: 1252 });
  const meta = await extractFileMetadata(new File([bytes], 'wrong.mobi'), 'wrong.mobi');
  assert.equal(meta.title, 'Café');
  assert.equal(meta.author, 'André');
});

test('TEXTREAD 记录也按 Kindle 记录目录读取，不把内部二进制当成书名', async () => {
  const bytes = kindleFile({ ident: 'TEXTREAD' });
  const meta = await extractFileMetadata(new File([bytes], 'wrong.mobi'), 'wrong.mobi');
  assert.equal(meta.title, '正确的中文书名');
});

for (const [name, version] of [['book.mobi', 6], ['book.azw3', 8], ['book.azw', 6]]) {
  test(`${name} 根据首图索引与封面偏移精读指定图片记录`, async () => {
    const cover = await extractCoverFromFile(new File([kindleFile({ version })], name), name);
    assert.equal(cover?.mime, 'image/png');
    assert.deepEqual(cover?.bytes, kindleCover);
  });
}

test('大文件封面在 2MB 以外时仍提取，且不读取正文或整书', async () => {
  const header = kindleHeader();
  const bytes = palmDatabase([header.bytes, new Uint8Array(3 * 1024 * 1024), new Uint8Array([1]), kindleCover]);
  const ranges = [];
  const file = {
    size: bytes.length,
    arrayBuffer() { throw new Error('禁止整读'); },
    slice(start, end) {
      ranges.push([start, end]);
      return new Blob([bytes.subarray(start, end)]);
    },
  };
  assert.deepEqual((await extractCoverFromFile(file, 'large.azw3'))?.bytes, kindleCover);
  assert.equal((await extractFileMetadata(file, 'large.azw3')).title, '正确的中文书名');
  assert.ok(ranges.reduce((total, [start, end]) => total + end - start, 0) < 16 * 1024, '只读取目录、元数据头和封面');
});

test('双格式文件读取 KF8 的更新书名，封面沿用共享的 MOBI7 图片基准', async () => {
  const legacy = kindleHeader({ title: '旧书名', firstImage: 2, extraRecords: [numberRecord(121, 5)] });
  const modern = kindleHeader({ version: 8, title: 'KF8 新书名', firstImage: 0xffffffff, coverOffset: 1 });
  const bytes = palmDatabase([
    legacy.bytes, new Uint8Array([1]), new Uint8Array([2]), kindleCover,
    new TextEncoder().encode('BOUNDARY'), modern.bytes,
  ]);
  assert.equal((await extractFileMetadata(new File([bytes], 'dual.mobi'), 'dual.mobi')).title, 'KF8 新书名');
  assert.deepEqual((await extractCoverFromFile(bytes, 'dual.mobi'))?.bytes, kindleCover);
});

test('双格式封面偏移指向 KF8 资源时，资源起点按 KF8 文本记录数计算', async () => {
  const legacy = kindleHeader({ title: '旧书名', firstImage: 2, extraRecords: [numberRecord(121, 5)] });
  const modern = kindleHeader({ version: 8, title: 'KF8 新书名', firstImage: 0xffffffff, textRecords: 1, coverOffset: 3 });
  const bytes = palmDatabase([
    legacy.bytes, new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]),
    new TextEncoder().encode('BOUNDARY'), modern.bytes, new TextEncoder().encode('KF8 正文'), kindleCover,
  ]);
  assert.deepEqual((await extractCoverFromFile(bytes, 'dual.mobi'))?.bytes, kindleCover);
});

test('无有效封面声明时不把任意正文图片当封面', async () => {
  const bytes = kindleFile({ coverOffset: null });
  assert.equal(await extractCoverFromFile(bytes, 'no-cover.mobi'), null);
});

test('越界或非图片封面记录不会导致导入失败', async () => {
  for (const coverOffset of [99, 0]) {
    const file = new File([kindleFile({ coverOffset })], 'bad-cover.azw3');
    assert.equal(await extractCoverFromFile(file, file.name), null);
    assert.equal((await extractFileMetadata(file, file.name)).title, '正确的中文书名');
  }
});

test('非 MOBI 和截断记录目录回退文件名，不接受二进制乱码书名', async () => {
  for (const bytes of [new Uint8Array(512).fill(0x61), kindleFile().subarray(0, 90)]) {
    const meta = await extractFileMetadata(new File([bytes], '可信书名.mobi'), '可信书名.mobi');
    assert.equal(meta.title, '可信书名');
    assert.equal(meta.author, '');
    assert.equal(await extractCoverFromFile(bytes, 'bad.mobi'), null);
  }
});

test('损坏 EXTH 的零长度记录及时退出，并保留可信完整书名', async () => {
  const bytes = kindleFile({ fullTitle: '完整可信书名' });
  const view = new DataView(bytes.buffer);
  const recordStart = view.getUint32(78);
  view.setUint32(recordStart + 16 + 232 + 12 + 4, 0);
  assert.equal((await extractFileMetadata(new File([bytes], 'broken.mobi'), 'broken.mobi')).title, '完整可信书名');
});

test('DRM 文件不破解，保留可读取的元数据但不提取受保护封面', async () => {
  const bytes = kindleFile({ encryption: 2 });
  const meta = await extractFileMetadata(new File([bytes], 'protected.azw3'), 'protected.azw3');
  assert.equal(meta.title, '正确的中文书名');
  assert.match(meta._meta?.warning || '', /DRM|加密/);
  assert.equal(await extractCoverFromFile(bytes, 'protected.azw3'), null);
});
