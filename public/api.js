// 同源请求会自动带上会话 Cookie，前端不再保存任何令牌
export function api(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options });
}

export async function loadMe() {
  try {
    const res = await api('/api/auth/me');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
