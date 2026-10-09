const encoder = new TextEncoder();
const decoder = new TextDecoder();

function configKey(env) {
  const secret = env.NVIDIA_CONFIG_SECRET || env.ADMIN_TOKEN;
  if (!secret || secret.length < 24) {
    throw new Error('NVIDIA_CONFIG_SECRET 或足够强度的 ADMIN_TOKEN 未配置，无法安全保存 NVIDIA 密钥');
  }
  return crypto.subtle.digest('SHA-256', encoder.encode(`cf-book:nvidia:${secret}`))
    .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
}

export async function encryptKeys(env, keys) {
  const key = await configKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(keys)));
  return JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) });
}

export async function decryptKeys(env, value) {
  try {
    const encrypted = JSON.parse(value || '{}');
    const key = await configKey(env);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(encrypted.iv) }, key, fromBase64(encrypted.data));
    const keys = JSON.parse(decoder.decode(plain));
    return Array.isArray(keys) ? keys.filter((item) => typeof item === 'string' && item) : [];
  } catch {
    throw new Error('NVIDIA 密钥无法解密，请重新保存配置');
  }
}

export function maskKey(value) {
  const key = String(value || '');
  return key.length <= 8 ? `${key.slice(0, 2)}****` : `${key.slice(0, 6)}****${key.slice(-4)}`;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
