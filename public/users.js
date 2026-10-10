import { api, loadMe, escapeHtml } from '/api.js';

const $ = (id) => document.getElementById(id);
const tbody = document.querySelector('#user-table tbody');

let me = null;

const ROLE_LABEL = { admin: '管理员', member: '成员' };

async function loadProviderConfig() {
  const status = $('provider-current');
  const res = await api('/api/ai/provider');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    status.textContent = `AI 设置读取失败：${data.error || res.status}`;
    return;
  }
  $('provider-format').value = data.format;
  $('provider-base-url').value = data.baseUrl;
  $('provider-model').innerHTML = data.model
    ? `<option value="${escapeHtml(data.model)}">${escapeHtml(data.model)}</option>`
    : '<option value="">先获取模型</option>';
  status.textContent = data.configured
    ? `已启用 ${data.format === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'} · ${data.model} · API Key 已保存`
    : '尚未配置自定义接口，当前使用 Workers AI。';
}

async function discoverProviderModels() {
  $('provider-discover').disabled = true;
  $('provider-status').textContent = '正在安全请求模型列表…';
  try {
    const res = await api('/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: $('provider-format').value,
        baseUrl: $('provider-base-url').value.trim(),
        apiKey: $('provider-api-key').value.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('provider-status').textContent = `获取模型失败：${data.error || res.status}`;
      return;
    }
    const select = $('provider-model');
    select.innerHTML = data.models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    $('provider-status').textContent = `已找到 ${data.models.length} 个模型，选择一个并保存配置。`;
  } catch (error) {
    $('provider-status').textContent = `获取模型失败：${error.message || error}`;
  } finally {
    $('provider-discover').disabled = false;
  }
}

async function saveProviderConfig(event) {
  event.preventDefault();
  $('provider-save').disabled = true;
  $('provider-status').textContent = '正在加密保存配置…';
  try {
    const res = await api('/api/ai/provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: $('provider-format').value,
        baseUrl: $('provider-base-url').value.trim(),
        model: $('provider-model').value,
        apiKey: $('provider-api-key').value.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('provider-status').textContent = `保存失败：${data.error || res.status}`;
      return;
    }
    $('provider-api-key').value = '';
    $('provider-status').textContent = '配置已保存；API Key 只在服务端加密保存。';
    await loadProviderConfig();
  } finally {
    $('provider-save').disabled = false;
  }
}

async function deleteProviderConfig() {
  if (!confirm('清除自定义 AI 配置？后续分类将恢复使用 Workers AI。')) return;
  const res = await api('/api/ai/provider', { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  $('provider-status').textContent = res.ok && data.ok ? '已清除自定义 AI 配置。' : `清除失败：${data.error || res.status}`;
  if (res.ok && data.ok) await loadProviderConfig();
}

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

async function classifyBatch({ force = false } = {}) {
  $('ai-classify').disabled = true;
  $('ai-reclassify-all').disabled = true;
  $('ai-msg').textContent = force ? '正在重新分类全部书籍…' : '正在整理…';
  try {
    let processed = 0;
    let failed = 0;
    let offset = 0;
    while (true) {
      const res = await api('/api/ai/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(force ? { limit: 10, offset, force: true } : { limit: 10 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        $('ai-msg').textContent = `整理失败：${data.error || res.status}；此前已处理 ${processed} 本`;
        await loadAiUsage();
        return;
      }
      processed += data.processed;
      failed += data.results.filter((result) => result.error).length;
      $('ai-msg').textContent = `${force ? '重新分类' : '整理'}中：已处理 ${processed} 本${failed ? `，失败 ${failed} 本` : ''}`;
      await loadAiUsage();
      if (!force || data.processed < data.batchLimit) break;
      offset += data.processed;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    $('ai-msg').textContent = `${force ? '重新分类' : '本批处理'}完成，共 ${processed} 本${failed ? `，失败 ${failed} 本` : ''}`;
  } finally {
    $('ai-classify').disabled = false;
    $('ai-reclassify-all').disabled = false;
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
  loadProviderConfig();
});

$('ai-classify').addEventListener('click', classifyBatch);
$('ai-reclassify-all').addEventListener('click', () => {
  if (confirm('将使用联网书目和 AI 重新处理全部书籍，更新书名和共享标签，并消耗今日 AI 额度。继续吗？')) {
    classifyBatch({ force: true });
  }
});
$('provider-discover').addEventListener('click', discoverProviderModels);
$('provider-form').addEventListener('submit', saveProviderConfig);
$('provider-delete').addEventListener('click', deleteProviderConfig);

// ---- 备份与恢复 ----

const BACKUP_TABLE_LABELS = {
  users: '账号',
  books: '书目',
  uploads: '上传任务',
  chunks: 'Telegram 分块索引',
  book_user_state: '评分与阅读状态',
  tag_dimensions: '标签维度',
  standard_tags: '标准标签',
  standard_tag_aliases: '标签别名',
  book_standard_tags: '书籍标准标签',
  tags: '自定义标签',
  book_tags: '书籍自定义标签',
};

let loadedBackup = null;

function setBackupReady(ready) {
  $('backup-preview').disabled = !ready;
  $('backup-restore').disabled = !ready;
}

function renderBackupSummary(summary) {
  const rows = Object.entries(summary)
    .map(([name, { incoming, current }]) =>
      `<li><span>${escapeHtml(BACKUP_TABLE_LABELS[name] || name)}</span><strong>备份 ${incoming} / 当前 ${current}</strong></li>`)
    .join('');
  $('backup-summary').innerHTML = rows ? `<ul class="backup-grid">${rows}</ul>` : '';
}

$('backup-export').addEventListener('click', () => {
  location.href = '/api/backup/export';
});

$('backup-export-plain').addEventListener('click', () => {
  if (!confirm('明文备份包含账号密码哈希和全部分块索引，请只保存在可信位置。继续下载吗？')) return;
  location.href = '/api/backup/export?encrypt=0';
});

$('backup-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  loadedBackup = null;
  setBackupReady(false);
  $('backup-summary').innerHTML = '';
  if (!file) return;
  try {
    loadedBackup = JSON.parse(await file.text());
    $('backup-msg').textContent = `已读取 ${file.name}，可先预览数据量。`;
    setBackupReady(true);
  } catch (error) {
    $('backup-msg').textContent = `备份文件不是有效的 JSON：${error.message}`;
  }
});

$('backup-preview').addEventListener('click', async () => {
  $('backup-preview').disabled = true;
  $('backup-msg').textContent = '正在读取备份内容…';
  try {
    const res = await api('/api/backup/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup: loadedBackup }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('backup-msg').textContent = `预览失败：${data.error || res.status}`;
      return;
    }
    renderBackupSummary(data.summary);
    $('backup-msg').textContent = `备份创建于 ${new Date(data.createdAt * 1000).toLocaleString()}，共 ${data.total} 条记录。`;
  } catch (error) {
    $('backup-msg').textContent = `预览失败：${error.message}`;
  } finally {
    $('backup-preview').disabled = false;
  }
});

$('backup-restore').addEventListener('click', async () => {
  const mode = $('backup-mode').value;
  const hint = mode === 'replace'
    ? '将先清空书目、账号、标签与分块索引，再按备份重建。'
    : '只补齐备份中的数据，不删除现有内容。';
  if (!confirm(`${hint}\n恢复只写数据库，不会改动 Telegram 原文件。确定继续吗？`)) return;

  $('backup-restore').disabled = true;
  $('backup-msg').textContent = '正在恢复…';
  try {
    const res = await api('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup: loadedBackup, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('backup-msg').textContent = `恢复失败：${data.error || res.status}`;
      return;
    }
    $('backup-msg').textContent = `恢复完成（${mode === 'replace' ? '覆盖' : '合并'}），共写入 ${Object.values(data.restored).reduce((a, b) => a + b, 0)} 条记录。`;
    await load();
  } catch (error) {
    $('backup-msg').textContent = `恢复失败：${error.message}`;
  } finally {
    $('backup-restore').disabled = false;
  }
});
