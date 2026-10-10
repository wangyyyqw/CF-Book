import { api, escapeHtml } from '/api.js';

const $ = (id) => document.getElementById(id);
const tbody = document.querySelector('#tag-table tbody');

// 标签库有近千条，列表只渲染前若干条，避免一次插入过多 DOM
const RENDER_LIMIT = 200;

let library = { dimensions: [], tags: [] };
let onlyUnused = false;
let search = '';
let editingId = '';

function dimensionLabel(dimension) {
  return library.dimensions.find((item) => item.dimension === dimension)?.name_zh || dimension;
}

function tagLabel(tag) {
  return `${tag.name}（${tag.tag_id}）`;
}

async function load() {
  const res = await api('/api/tags/admin');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('tag-stats').innerHTML = `<span>标签库读取失败：${escapeHtml(data.error || res.status)}</span>`;
    return;
  }
  library = { dimensions: data.dimensions || [], tags: data.tags || [] };
  renderStats();
  renderDimensionSelect();
  renderMergeSelects();
  renderTable();
}

function renderStats() {
  const active = library.tags.filter((tag) => tag.status !== 'disabled').length;
  const unused = library.tags.filter((tag) => tag.usage_count === 0).length;
  $('tag-stats').innerHTML = `
    <span>标签总数 <strong>${library.tags.length}</strong></span>
    <span>启用 <strong>${active}</strong></span>
    <span>已停用 <strong>${library.tags.length - active}</strong></span>
    <span>从未使用 <strong>${unused}</strong></span>`;
}

function renderDimensionSelect() {
  const select = $('new-tag-dimension');
  const current = select.value;
  select.innerHTML = library.dimensions
    .map((item) => `<option value="${escapeHtml(item.dimension)}">${escapeHtml(item.name_zh)}</option>`)
    .join('');
  if (library.dimensions.some((item) => item.dimension === current)) select.value = current;
}

function renderMergeSelects() {
  const groups = library.dimensions.map((dimension) => {
    const options = library.tags
      .filter((tag) => tag.dimension === dimension.dimension)
      .map((tag) => `<option value="${escapeHtml(tag.tag_id)}">${escapeHtml(tagLabel(tag))}</option>`)
      .join('');
    return options ? `<optgroup label="${escapeHtml(dimension.name_zh)}">${options}</optgroup>` : '';
  }).join('');
  for (const [id, placeholder] of [['merge-from', '源标签（将被删除）'], ['merge-to', '目标标签（保留）']]) {
    const select = $(id);
    const current = select.value;
    select.innerHTML = `<option value="">${placeholder}</option>${groups}`;
    if (current) select.value = current;
  }
}

function filteredTags() {
  const keyword = search.trim().toLowerCase();
  return library.tags.filter((tag) => {
    if (onlyUnused && tag.usage_count > 0) return false;
    if (!keyword) return true;
    return tag.name.toLowerCase().includes(keyword) ||
      tag.tag_id.toLowerCase().includes(keyword) ||
      tag.aliases.some((alias) => alias.toLowerCase().includes(keyword));
  });
}

function rowHtml(tag) {
  const id = escapeHtml(tag.tag_id);
  if (tag.tag_id === editingId) {
    return `<tr class="tag-row editing" data-id="${id}">
      <td><input class="e-name" value="${escapeHtml(tag.name)}" maxlength="40" /></td>
      <td>${escapeHtml(dimensionLabel(tag.dimension))}</td>
      <td><input class="e-category" value="${escapeHtml(tag.category)}" maxlength="40" /></td>
      <td>${tag.usage_count}</td>
      <td>
        <select class="e-status">
          <option value="active" ${tag.status !== 'disabled' ? 'selected' : ''}>启用</option>
          <option value="disabled" ${tag.status === 'disabled' ? 'selected' : ''}>停用</option>
        </select>
      </td>
      <td><input class="e-aliases" value="${escapeHtml(tag.aliases.join(', '))}" /></td>
      <td class="tag-row-actions">
        <button type="button" data-action="save">保存</button>
        <button type="button" data-action="cancel">取消</button>
      </td>
    </tr>`;
  }
  const disabled = tag.status === 'disabled';
  const aliases = tag.aliases.length ? escapeHtml(tag.aliases.join('、')) : '<span class="muted">—</span>';
  return `<tr class="tag-row${disabled ? ' disabled' : ''}" data-id="${id}">
    <td><strong>${escapeHtml(tag.name)}</strong><br /><span class="tag-id">${id}</span></td>
    <td>${escapeHtml(dimensionLabel(tag.dimension))}</td>
    <td>${escapeHtml(tag.category)}</td>
    <td>${tag.usage_count}</td>
    <td>${disabled ? '已停用' : '启用'}</td>
    <td>${aliases}</td>
    <td class="tag-row-actions">
      <button type="button" data-action="edit">编辑</button>
      <button type="button" data-action="toggle">${disabled ? '启用' : '停用'}</button>
      <button type="button" data-action="delete">删除</button>
    </td>
  </tr>`;
}

function renderTable() {
  const rows = filteredTags();
  const shown = rows.slice(0, RENDER_LIMIT);
  tbody.innerHTML = shown.length
    ? shown.map(rowHtml).join('')
    : '<tr><td colspan="7" class="muted">没有匹配的标签。</td></tr>';
  $('tag-list-note').textContent = rows.length > shown.length
    ? `匹配 ${rows.length} 个，先显示前 ${shown.length} 个，可用搜索缩小范围`
    : `匹配 ${rows.length} 个`;
}

async function send(url, options) {
  const res = await api(url, options);
  return { res, data: await res.json().catch(() => ({})) };
}

async function saveRow(row) {
  const body = {
    tagId: row.dataset.id,
    name: row.querySelector('.e-name').value.trim(),
    category: row.querySelector('.e-category').value.trim(),
    status: row.querySelector('.e-status').value,
    aliases: row.querySelector('.e-aliases').value,
  };
  const { res, data } = await send('/api/tags/admin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !data.ok) {
    $('tag-list-msg').textContent = `保存失败：${data.error || res.status}`;
    return;
  }
  editingId = '';
  $('tag-list-msg').textContent = '✓ 标签已更新';
  await load();
}

tbody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('tr');
  const tagId = row.dataset.id;
  const tag = library.tags.find((item) => item.tag_id === tagId);
  if (!tag) return;

  if (button.dataset.action === 'edit') {
    editingId = tagId;
    renderTable();
    return;
  }
  if (button.dataset.action === 'cancel') {
    editingId = '';
    renderTable();
    return;
  }
  if (button.dataset.action === 'save') {
    await saveRow(row);
    return;
  }
  if (button.dataset.action === 'toggle') {
    const { res, data } = await send('/api/tags/admin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId, status: tag.status === 'disabled' ? 'active' : 'disabled' }),
    });
    $('tag-list-msg').textContent = res.ok && data.ok
      ? `✓ 已${tag.status === 'disabled' ? '启用' : '停用'}「${tag.name}」`
      : `操作失败：${data.error || res.status}`;
    if (res.ok && data.ok) await load();
    return;
  }
  if (button.dataset.action === 'delete') {
    const warning = tag.usage_count > 0
      ? `标签「${tag.name}」正被 ${tag.usage_count} 本书使用，删除后这些书的该标签也会消失。`
      : `删除标签「${tag.name}」？`;
    if (!window.confirm(`${warning}\n如果只是重复标签，建议改用“合并重复标签”。`)) return;
    const { res, data } = await send(`/api/tags/admin?tag_id=${encodeURIComponent(tagId)}`, { method: 'DELETE' });
    $('tag-list-msg').textContent = res.ok && data.ok
      ? `✓ 已删除「${tag.name}」`
      : `删除失败：${data.error || res.status}`;
    if (res.ok && data.ok) await load();
  }
});

$('tag-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    name: $('new-tag-name').value.trim(),
    dimension: $('new-tag-dimension').value,
    category: $('new-tag-category').value.trim(),
    parent_id: $('new-tag-parent').value.trim(),
    aliases: $('new-tag-aliases').value,
    description: $('new-tag-description').value.trim(),
  };
  const { res, data } = await send('/api/tags/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !data.ok) {
    $('tag-create-msg').textContent = `新建失败：${data.error || res.status}`;
    return;
  }
  $('tag-create-msg').textContent = `✓ 已新建 ${data.tag.tag_id}`;
  $('new-tag-name').value = '';
  $('new-tag-aliases').value = '';
  $('new-tag-description').value = '';
  await load();
});

$('tag-merge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const from = $('merge-from').value;
  const to = $('merge-to').value;
  if (!from || !to) {
    $('tag-merge-msg').textContent = '请选择源标签和目标标签';
    return;
  }
  if (!window.confirm('合并后源标签会被删除，确定继续？')) return;
  const { res, data } = await send('/api/tags/admin/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  $('tag-merge-msg').textContent = res.ok && data.ok
    ? `✓ 已把「${data.from}」合并到「${data.to}」，迁移 ${data.merged_books} 本书`
    : `合并失败：${data.error || res.status}`;
  if (res.ok && data.ok) await load();
});

$('export-tags').addEventListener('click', () => {
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    dimensions: library.dimensions,
    tags: library.tags.map((tag) => ({
      tag_id: tag.tag_id,
      name: tag.name,
      dimension: tag.dimension,
      category: tag.category,
      parent_id: tag.parent_id,
      description: tag.description,
      status: tag.status,
      aliases: tag.aliases,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cf-book-tags-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  $('tag-admin-msg').textContent = `✓ 已导出 ${payload.tags.length} 个标签`;
});

$('import-tags').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('tag-admin-msg').textContent = '正在导入…';
  try {
    const payload = JSON.parse(await file.text());
    const { res, data } = await send('/api/tags/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: payload.tags || payload }),
    });
    $('tag-admin-msg').textContent = res.ok && data.ok
      ? `✓ 导入完成：新建 ${data.created}，更新 ${data.updated}，跳过 ${data.skipped.length}`
      : `导入失败：${data.error || res.status}`;
    if (res.ok && data.ok) await load();
  } catch (error) {
    $('tag-admin-msg').textContent = `导入失败：${error.message}`;
  } finally {
    event.target.value = '';
  }
});

$('only-unused').addEventListener('click', () => {
  onlyUnused = !onlyUnused;
  $('only-unused').classList.toggle('active', onlyUnused);
  $('only-unused').textContent = onlyUnused ? '显示全部标签' : '只看从未使用';
  renderTable();
});

$('tag-search').addEventListener('input', debounce(() => {
  search = $('tag-search').value;
  renderTable();
}, 200));

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

load();
