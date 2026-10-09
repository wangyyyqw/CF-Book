import { err } from '../../utils/http.js';

// 按二进制魔数探测真实图片类型，兼容旧数据（路径 .jpg 但实际存的是 webp/png）
function sniffMime(bytes) {
  if (bytes.length < 12) return 'image/jpeg';
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return 'image/jpeg';
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const key = `covers/${String(params.key || '')}`;
  const obj = await env.COVERS.get(key);
  if (!obj) return err('封面不存在', 404);

  // 先探测真实类型；探测不到时退回 R2 记录的 contentType
  const bytes = await obj.arrayBuffer().catch(() => null);
  const contentType = bytes ? sniffMime(new Uint8Array(bytes)) : (obj.httpMetadata?.contentType || 'image/jpeg');

  return new Response(bytes, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
