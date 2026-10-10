// 同源请求会自动带上会话 Cookie，前端不再保存任何令牌
export function api(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options });
}

let meCache;
let mePromise;

export async function loadMe() {
  if (meCache !== undefined) return meCache;
  if (!mePromise) {
    mePromise = (async () => {
      try {
        const res = await api('/api/auth/me');
        meCache = res.ok ? await res.json() : null;
      } catch {
        meCache = null;
      } finally {
        mePromise = null;
      }
      return meCache;
    })();
  }
  return mePromise;
}

export function clearMeCache() {
  meCache = undefined;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
