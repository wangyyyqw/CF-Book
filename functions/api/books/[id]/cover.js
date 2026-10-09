import { json, err } from '../../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../../utils/db.js';

const MAX_COVER = 8 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  const book = await dbGet(env, 'SELECT * FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);
  if (user.role !== 'admin' && book.created_by !== user.username) {
    return err('只能修改自己上传书籍的封面', 403);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return err('请求体必须是 multipart/form-data');
  const file = form.get('file');
  const sourceUrl = String(form.get('sourceUrl') || '').trim();
  if (!file && !sourceUrl) return err('缺少 file 或 sourceUrl 字段');

  let bytes;
  let mime;
  if (sourceUrl) {
    let fetched;
    try {
      fetched = await fetchCoverUrl(sourceUrl);
    } catch (e) {
      return err(`外链封面下载失败：${e.message}`, 502);
    }
    if (!fetched.ok) return err(`外链封面下载失败：${fetched.status}`, 502);
    const length = Number(fetched.headers.get('content-length') || 0);
    if (length > MAX_COVER) return err('封面不能超过 8MB');
    bytes = await fetched.arrayBuffer();
    mime = String(fetched.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  } else {
    if (file.size > MAX_COVER) return err('封面不能超过 8MB');
    bytes = await file.arrayBuffer();
    mime = String(file.type || '').split(';')[0].trim().toLowerCase();
  }
  if (bytes.byteLength === 0) return err('封面内容为空');

  // 按实际 MIME 决定存储类型，避免 WebP/PNG 被误标为 JPEG 导致前端解码失败
  if (bytes.byteLength > MAX_COVER) return err('封面不能超过 8MB');
  const detectedMime = sniffImageMime(new Uint8Array(bytes));
  const contentType = detectedMime || mime || '';
  if (!detectedMime) return err('封面不是支持的图片格式');
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extMap[contentType] || 'jpg';

  const key = `covers/${params.id}.${ext}`;
  await env.COVERS.put(key, bytes, {
    httpMetadata: { contentType },
  });

  const coverPath = `/api/covers/${params.id}.${ext}`;
  await dbRun(env, 'UPDATE books SET cover = ?, updated_at = ? WHERE id = ?', coverPath, nowSec(), params.id);

  return json({ ok: true, cover: coverPath, key });
}

async function fetchCoverUrl(sourceUrl) {
  let url = new URL(sourceUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    validateCoverUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 3) return response;
    url = new URL(location, url);
  }
  throw new Error('封面重定向次数过多');
}

function validateCoverUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('封面 URL 必须使用 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('封面 URL 不支持账号密码');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('封面 URL 不能指向本地地址');
  }
  if (isPrivateIpv4(host) || host === '::1' || host === '[::1]') {
    throw new Error('封面 URL 不能指向内网地址');
  }
}

function isPrivateIpv4(host) {
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some((part) => part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function sniffImageMime(bytes) {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return '';
}
