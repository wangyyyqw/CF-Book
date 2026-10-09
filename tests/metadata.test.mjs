import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../public/vendor/fflate.js';
import { extractCoverFromFile } from '../public/metadata.js';

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
