import { strFromU8, inflateSync } from './vendor/fflate.js';
import { readKindleMetadata, readKindleCover } from './kindle.js';

// —— zip 按需读取（不整读文件，兼容浏览器 File 与 Node Buffer/Uint8Array） ——

// 读取文件 [start, end) 字节
async function readRange(file, start, end) {
  if (typeof file.slice === 'function' && typeof file.arrayBuffer === 'function') {
    // 浏览器 File
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }
  // Uint8Array / Buffer
  const u8 = file instanceof Uint8Array ? file : new Uint8Array(file);
  return u8.subarray(start, Math.min(end, u8.length)).slice();
}

async function readAll(file) {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return file instanceof Uint8Array ? file.slice() : new Uint8Array(file);
}

// 从 EOCD 尾部找到 central directory 偏移
async function findEocd(file, size) {
  const tailLen = Math.min(size, 72 * 1024);
  const tail = await readRange(file, size - tailLen, size);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  // 从后往前找 EOCD 签名 0x06054b50（最后 22 字节开始）
  const eocd = (() => {
    for (let i = tail.length - 22; i >= 0 && i >= tail.length - 65557; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) return null;
  const eocdAbs = size - tailLen + eocd; // 绝对偏移
  const totalEntries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  return { eocdAbs, totalEntries, cdSize, cdOffset };
}

// 从文件读取并解析 central directory（按 EOCD 提供的偏移精读，避免大文件超界）
async function readCentralDir(file, size) {
  const eocdInfo = await findEocd(file, size);
  if (!eocdInfo) return null;
  const { totalEntries, cdSize, cdOffset } = eocdInfo;
  if (cdOffset + cdSize > size || cdSize > 16 * 1024 * 1024) return null;
  const cd = await readRange(file, cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cd.length) break;
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 按 offset 读取并解压单个 zip 条目
async function readEntry(file, entry) {
  // local file header
  const header = await readRange(file, entry.localOffset, entry.localOffset + 30);
  if (header.length < 30) throw new Error('bad local header');
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('bad local header');
  const method = entry.method;
  // ZIP data descriptor 模式下，local header 的大小字段为 0；中央目录才是准确值。
  const compSize = entry.compSize;
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const comp = await readRange(file, dataStart, dataStart + compSize);
  if (method === 0) return comp.slice();
  return inflateSync(comp);
}

// 给定任意文件源，返回 EPUB 的 container.xml + OPF 元数据
export async function epubMeta(file) {
  try {
    // 1. 按 EOCD 记录的偏移精读 central directory
    const size = typeof file.size === 'number' ? file.size : file.length || file.byteLength;
    const entries = await readCentralDir(file, size);
    if (!entries) return null;

    const containerEntry = entries.find((e) => e.name === 'META-INF/container.xml');
    if (!containerEntry) return null;
    const containerXml = strFromU8(await readEntry(file, containerEntry));
    const opfMatch = containerXml.match(/full-path\s*=\s*"([^"]+)"/i);
    if (!opfMatch) return null;
    const opfPath = opfMatch[1].replace(/\\/g, '/').replace(/^\//, '');

    const opfEntry = entries.find((e) => e.name === opfPath || e.name === opfPath.toLowerCase());
    if (!opfEntry) return null;
    const opf = strFromU8(await readEntry(file, opfEntry));

    const field = (name) => {
      const re = new RegExp(`<dc:${name}[^>]*>([\\s\\S]*?)<\\/dc:${name}>`, 'i');
      const m = opf.match(re);
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    };
    const authors = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)]
      .map((m) => m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
    const identifier = field('identifier');

    return {
      title: field('title'),
      author: authors[0] || '',
      language: field('language'),
      publisher: field('publisher'),
      date: field('date').slice(0, 10),
      isbn: identifier.replace(/^.*?[:\s]*([0-9Xx-]{10,17}).*$/, '$1'),
      description: field('description'),
      // 返回 OPF 里的封面 item 信息，供 extractCover 复用
      _opf: opf,
      _entries: entries,
      _file: file,
      _opfDir: opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '',
    };
  } catch (e) {
    return null;
  }
}

// 从 EPUB 提取内嵌封面图（复用 epubMeta 拿到的 OPF 与条目表）
export async function extractCoverFromMeta(meta) {
  if (!meta?._opf) return null;
  try {
    const opf = meta._opf;
    const entries = meta._entries;
    const file = meta._file;
    const coverId =
      (opf.match(/<meta\s+name\s*=\s*"(?:cover|cover-image)"[^>]*content\s*=\s*"([^"]+)"/i) || [])[1] ||
      (opf.match(/<meta\s+content\s*=\s*"([^"]+)"[^>]*name\s*=\s*"(?:cover|cover-image)"/i) || [])[1];

    let coverName = '';
    if (coverId) {
      const itemRe = new RegExp(`<item[^>]*id\\s*=\\s*["']${escapeRe(coverId)}["'][^>]*href\\s*=\\s*["']([^"']+)["']`, 'i');
      const item = opf.match(itemRe) || opf.match(new RegExp(`<item[^>]*href\\s*=\\s*["']([^"']+)["'][^>]*id\\s*=\\s*["']${escapeRe(coverId)}["']`, 'i'));
      coverName = item ? item[1] : '';
    }

    // EPUB3 标准：<item properties="cover-image" href="..."/>
    if (!coverName) {
      const propRe = /<item\b[^>]*properties\s*=\s*"[^"]*cover-image[^"]*"[^>]*href\s*=\s*"([^"]+)"/i;
      const m = opf.match(propRe) || opf.match(/<item\b[^>]*href\s*=\s*"([^"]+)"[^>]*properties\s*=\s*"[^"]*cover-image[^"]*"/i);
      if (m) coverName = m[1];
    }

    // 回退常见封面文件名
    if (!coverName) {
      // 按 basename 匹配 cover/front 等常见封面名，忽略目录
      const commonBase = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'front.jpg', 'front.png', 'cover_image.jpg', 'cover_image.png'];
      const found = entries.find((e) => commonBase.includes(e.name.split('/').pop().toLowerCase()));
      if (found) coverName = found.name;
    }

    // 多看等制作工具用 OPF2 <guide><reference type="cover" href="..."/> 声明封面页，
    // 封面图常是纯数字文件名（如 Images/92.jpg），靠上面的文件名回退都命不中。
    // 按 guide 指向的页面取首个 <img>：本地图走 ZIP 提取，外链交给后端抓取。
    if (!coverName) {
      const guideHref = guideCoverHref(opf);
      const guideEntry = guideHref ? resolveEntry(entries, guideHref, meta._opfDir) : null;
      if (guideEntry) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(guideEntry.name)) {
          coverName = guideEntry.name;
        } else if (/\.(xhtml|html|htm)$/i.test(guideEntry.name)) {
          const html = strFromU8(await readEntry(file, guideEntry));
          const image = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
          if (image?.[1]) {
            const source = decodeXmlEntities(image[1].trim());
            if (/^https?:\/\//i.test(source)) return { url: source };
            coverName = resolvePath(guideEntry.name, source);
          }
        }
      }
    }

    // 部分微信读书 EPUB 没有 OPF cover 声明，只在 cover.xhtml 中放外链图片。
    // 先尝试常见封面页，内部图片仍走本地 ZIP 提取，外链交给后端抓取以绕过 CORS。
    if (!coverName) {
      const coverPage = await findCoverPage(entries, file);
      if (coverPage) {
        const image = coverPage.html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
        if (image?.[1]) {
          const source = decodeXmlEntities(image[1].trim());
          if (/^https?:\/\//i.test(source)) return { url: source };
          coverName = resolvePath(coverPage.name, source);
        }
      }
    }

    if (!coverName) return null;
    const decodedCoverName = decodeZipHref(coverName).replace(/\\/g, '/');
    // EPUB manifest href 相对 OPF 目录，允许 ../ 指向压缩包根目录。
    const candidates = new Set([
      normalizeZipPath(decodedCoverName),
      normalizeZipPath(`${meta._opfDir}${decodedCoverName}`),
    ]);
    const entry = entries.find((e) => candidates.has(normalizeZipPath(e.name)));
    if (!entry) return null;

    const bytes = await readEntry(file, entry);
    const extension = decodedCoverName.match(/\.(png|webp|jpe?g|gif)$/i)?.[1]?.toLowerCase();
    const mime = extension
      ? { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[extension]
      : 'image/jpeg';
    return { bytes, mime };
  } catch (e) {
    return null;
  }
}

async function findCoverPage(entries, file) {
  const pages = entries.filter((entry) => {
    const name = entry.name.toLowerCase();
    return /\.(xhtml|html|htm)$/.test(name) && /(^|\/)cover|(^|\/)front/.test(name);
  });
  for (const page of pages) {
    const html = strFromU8(await readEntry(file, page));
    if (/<img\b/i.test(html)) return { name: page.name, html };
  }
  return null;
}

function decodeXmlEntities(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function decodeZipHref(href) {
  const path = decodeXmlEntities(href).split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolvePath(pageName, href) {
  const base = pageName.split('/');
  base.pop();
  for (const part of href.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}

// 取 OPF2 <guide> 中 type="cover" 的 reference href（多看等工具用它声明封面页）
function guideCoverHref(opf) {
  const guide = opf.match(/<guide\b[\s\S]*?<\/guide>/i)?.[0];
  if (!guide) return '';
  for (const tag of guide.match(/<reference\b[^>]*>/gi) || []) {
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!type || type.trim().toLowerCase() !== 'cover') continue;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) return href.trim();
  }
  return '';
}

// href 相对 OPF 目录解析为 ZIP 条目，兼容 ../ 与 URL 编码
function resolveEntry(entries, href, opfDir) {
  const decoded = decodeZipHref(href).replace(/\\/g, '/');
  const candidates = new Set([
    normalizeZipPath(decoded),
    normalizeZipPath(`${opfDir}${decoded}`),
  ]);
  return entries.find((e) => candidates.has(normalizeZipPath(e.name))) || null;
}

function normalizeZipPath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 从文件名解析书名/作者，支持常见格式
export function parseFilename(name) {
  let base = String(name || '').replace(/\.[^.]+$/, '');
  base = base.replace(/\s*\(z-library[^)]*\)$/i, '');
  base = base.replace(/\s*\[z-lib\.org\]$/i, '');
  base = base.trim();
  const m = { title: base, author: '' };

  // 书名（作者）[修饰词...]
  let r = base.match(/^(.+?)[（(]\s*([^（）()]{2,30})\s*[）)](\s*.*)$/);
  if (r && !r[1].includes('（') && !r[1].includes('(')) {
    m.title = (r[1] + (r[3] ? r[3].trim() : '')).trim();
    m.author = r[2].trim();
    return clean(m);
  }

  // [作者] 书名
  r = base.match(/^\[(.+?)\]\s*(.+)$/);
  if (r) {
    m.title = r[2].trim();
    m.author = r[1].trim();
    return clean(m);
  }

  // 作者 - 书名 / 作者_书名 / 作者——书名
  r = base.match(/^([^\-–—_]+)[\s\-–—_]+(.+)$/);
  if (r) {
    m.author = r[1].trim();
    m.title = r[2].trim();
    return clean(m);
  }

  if (m.title) {
    m.title = m.title.replace(/_/g, ' ').trim();
  }
  if (m.author) {
    m.author = m.author.replace(/[_\-]/g, ' ').trim();
  }
  return m;
}

function clean(m) {
  m.title = m.title.replace(/_/g, ' ').trim();
  m.author = m.author.replace(/[_\-]/g, ' ').trim();
  return m;
}

// 从 PDF 头部提取 Title/Author 元数据（xmp / info dict）
export function pdfMeta(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const max = Math.min(u8.length, 2 * 1024 * 1024);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(0, max));
    const out = { title: '', author: '' };
    const findInfo = (key) => {
      const re = new RegExp(`/\\s*${key}\\s*\\(([^)]*)\\)`, 'i');
      const m = text.match(re);
      return m ? m[1] : '';
    };
    out.title = findInfo('Title');
    out.author = findInfo('Author');
    return out.title || out.author ? out : null;
  } catch (e) {
    return null;
  }
}

// 统一入口：给定 File 对象（支持 slice 流式读取），返回元数据
export async function extractFileMetadata(file, fileName) {
  const ext = (String(fileName).match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || '';
  let meta = null;
  const inferred = parseFilename(fileName);

  if (ext === 'epub') {
    meta = await epubMeta(file);
  } else if (['mobi', 'azw3', 'azw'].includes(ext)) {
    meta = await readKindleMetadata(file);
  } else if (ext === 'pdf') {
    const head = await readRange(file, 0, Math.min(2 * 1024 * 1024, file.size ?? file.byteLength));
    meta = pdfMeta(head);
  }

  const title = (meta?.title && meta.title.trim()) || inferred.title || String(fileName).replace(/\.[^.]+$/, '');
  const author = (meta?.author && meta.author.trim()) || inferred.author || '';
  return {
    title,
    author,
    format: ext,
    publisher: meta?.publisher || '',
    language: meta?.language || '',
    isbn: meta?.isbn || '',
    description: meta?.description || '',
    date: meta?.date || '',
    warning: meta?.warning || '',
    _meta: meta,
  };
}

// 统一入口：按需提取 EPUB、MOBI 与 AZW3 封面。
export async function extractCoverFromFile(file, fileName) {
  const ext = (String(fileName).match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || '';
  if (['mobi', 'azw3', 'azw'].includes(ext)) return readKindleCover(file);
  if (ext !== 'epub') return null;
  const meta = await epubMeta(file);
  if (!meta) return null;
  return extractCoverFromMeta(meta);
}
