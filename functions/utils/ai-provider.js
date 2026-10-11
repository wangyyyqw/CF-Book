const encoder = new TextEncoder();
const decoder = new TextDecoder();

function configKey(env) {
  const secret = env.AI_CONFIG_SECRET || env.ADMIN_TOKEN;
  if (!secret || secret.length < 24) throw new Error('AI_CONFIG_SECRET 或足够强度的 ADMIN_TOKEN 未配置');
  return crypto.subtle.digest('SHA-256', encoder.encode(`cf-book:provider:${secret}`))
    .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
}

export async function encryptApiKey(env, value) {
  const key = await configKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(data)) });
}

export async function decryptApiKey(env, value) {
  try {
    const encrypted = JSON.parse(value || '{}');
    const key = await configKey(env);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encrypted.iv) }, key, decode(encrypted.data));
    return decoder.decode(plain);
  } catch {
    throw new Error('AI API Key 无法解密，请重新保存配置');
  }
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('请求地址必须是有效的 HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('请求地址只接受不含凭据、查询参数和片段的 HTTPS URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLocalHostname(hostname)) throw new Error('请求地址不能指向本机或内网主机');
  return url.toString().replace(/\/+$/, '');
}

export function providerFetch(input, init = {}) {
  return fetch(input, { ...init, redirect: 'manual' });
}

export function isLocalHostname(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  if (hostname.includes(':')) {
    const mappedIpv4 = hostname.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedIpv4) {
      const high = Number.parseInt(mappedIpv4[1], 16);
      const low = Number.parseInt(mappedIpv4[2], 16);
      return isLocalHostname(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return hostname === '::' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb');
  }
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
