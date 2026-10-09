import { api, loadMe, escapeHtml } from '/api.js';

const $ = (id) => document.getElementById(id);
const tbody = document.querySelector('#user-table tbody');

let me = null;

const ROLE_LABEL = { admin: '管理员', member: '成员' };

async function loadAiUsage() {
  const res = await api('/api/ai/classify');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('ai-usage').textContent = `额度读取失败：${data.error || res.status}`;
    return;
  }
  const percent = data.dailyLimit ? Math.min(100, data.usedNeurons / data.dailyLimit * 100) : 0;
  $('ai-usage').innerHTML = `
    <span><strong>${data.usedNeurons.toFixed(2)}</strong> / ${data.dailyLimit.toLocaleString()} 估算 Neurons</span>
    <span>今日请求 ${data.requests} 次 · 完成 ${data.completed} · 失败 ${data.failed}</span>
    <span>剩余 ${(data.dailyLimit - data.usedNeurons).toFixed(2)} · 已用 ${percent.toFixed(1)}%</span>
    <span>待整理 ${data.pending} / 共 ${data.totalBooks} 本</span>`;
  $('ai-meter-fill').style.width = `${percent}%`;
  $('ai-meter-fill').title = `${percent.toFixed(1)}%`;
}

async function classifyBatch() {
  $('ai-classify').disabled = true;
  $('ai-msg').textContent = '正在整理，每次最多处理 10 本…';
  try {
    const res = await api('/api/ai/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('ai-msg').textContent = `整理失败：${data.error || res.status}`;
      return;
    }
    const failed = data.results.filter((result) => result.error).length;
    $('ai-msg').textContent = `本批处理 ${data.processed} 本${failed ? `，失败 ${failed} 本` : ''}`;
    await loadAiUsage();
  } finally {
    $('ai-classify').disabled = false;
  }
}

async function load() {
  const res = await api('/api/users');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('list-msg').textContent = `加载失败：${data.error || res.status}`;
    return;
  }
  $('list-msg').textContent = '';
  render(data.users);
}

function render(users) {
  tbody.innerHTML = users
    .map((u) => {
      const self = me && u.id === me.id;
      const disabled = Boolean(u.disabled);
      return `<tr data-id="${escapeHtml(u.id)}">
        <td>${escapeHtml(u.username)}${self ? ' <span class="muted">（我）</span>' : ''}</td>
        <td>${escapeHtml(u.display_name || '')}</td>
        <td>${escapeHtml(ROLE_LABEL[u.role] || u.role)}</td>
        <td>${disabled ? '已停用' : '正常'}</td>
        <td class="row-actions">
          <button type="button" data-action="password">重置密码</button>
          <button type="button" data-action="role" data-role="${u.role === 'admin' ? 'member' : 'admin'}" ${self ? 'disabled' : ''}>
            设为${u.role === 'admin' ? '成员' : '管理员'}
          </button>
          <button type="button" data-action="toggle" ${self ? 'disabled' : ''}>${disabled ? '启用' : '停用'}</button>
          <button type="button" class="danger" data-action="delete" ${self ? 'disabled' : ''}>删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function patch(id, body, okText) {
  const res = await api(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('list-msg').textContent = `操作失败：${data.error || res.status}`;
    return false;
  }
  $('list-msg').textContent = okText;
  return true;
}

tbody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('tr').dataset.id;
  const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'password') {
      const password = prompt('请输入新的密码（至少 6 位）');
      if (!password) return;
      if (await patch(id, { password }, '密码已重置，该账号需重新登录')) await load();
      return;
    }
    if (action === 'role') {
      if (await patch(id, { role: button.dataset.role }, '角色已更新')) await load();
      return;
    }
    if (action === 'toggle') {
      const disabled = button.textContent.trim() === '停用';
      if (disabled && !confirm('停用后该账号将无法登录，确定吗？')) return;
      if (await patch(id, { disabled }, disabled ? '账号已停用' : '账号已启用')) await load();
      return;
    }
    if (action === 'delete') {
      if (!confirm('删除后不可恢复，确定删除该账号吗？')) return;
      const res = await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        $('list-msg').textContent = `删除失败：${data.error || res.status}`;
        return;
      }
      $('list-msg').textContent = '账号已删除';
      await load();
    }
  } finally {
    button.disabled = false;
  }
});

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    username: $('new-username').value.trim(),
    displayName: $('new-display').value.trim(),
    password: $('new-password').value,
    role: $('new-role').value,
  };
  const res = await api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('create-msg').textContent = `创建失败：${data.error || res.status}`;
    return;
  }
  $('create-msg').textContent = `已创建 ${payload.username}`;
  $('new-username').value = '';
  $('new-display').value = '';
  $('new-password').value = '';
  await load();
});

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await api('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: $('current-password').value,
      newPassword: $('next-password').value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('password-msg').textContent = `修改失败：${data.error || res.status}`;
    return;
  }
  $('password-msg').textContent = '密码已更新';
  $('current-password').value = '';
  $('next-password').value = '';
});

loadMe().then((data) => {
  me = data?.user || null;
  if (me && me.role !== 'admin') {
    document.querySelector('.shell').innerHTML = '<p class="empty">仅管理员可访问账号管理。</p>';
    return;
  }
  load();
  loadAiUsage();
});

$('ai-classify').addEventListener('click', classifyBatch);
