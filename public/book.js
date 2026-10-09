import { api, loadMe, escapeHtml } from '/api.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

// 仅管理员可编辑的书籍信息字段
const FIELDS = ['title', 'author', 'description', 'publisher', 'isbn', 'language', 'format', 'cover'];
const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' };

let me = null;

function renderCover(url) {
  const img = $('cover');
  if (url) {
    img.src = url;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }
}

function renderRatings(book) {
  $('ratings-title').textContent = book.rating_count
    ? `大家的打分 · 平均 ${Number(book.rating_avg).toFixed(1)}（${book.rating_count} 人）`
    : '大家的打分';

  const rows = (book.ratings || []).filter((r) => Number(r.rating) > 0 || r.status !== 'unread');
  if (!rows.length) {
    $('ratings').innerHTML = '<li class="muted">还没有人打分或标记状态</li>';
    return;
  }
  $('ratings').innerHTML = rows
    .map((r) => {
      const mine = me && r.user_id === me.id;
      const score = Number(r.rating) > 0 ? Number(r.rating).toFixed(1) : '—';
      return `<li class="${mine ? 'mine' : ''}">
        <span class="who">${escapeHtml(r.display_name || r.username)}${mine ? '（我）' : ''}</span>
        <span class="score">${score}</span>
        <span class="st">${escapeHtml(STATUS_LABEL[r.status] || r.status)}${r.is_favorite ? ' · 收藏' : ''}</span>
      </li>`;
    })
    .join('');
}

async function load() {
  const res = await api(`/api/books/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('book-title').textContent = '加载失败：' + (data.error || res.status);
    return;
  }
  const b = data.book;
  $('book-title').textContent = b.title || '未命名';
  $('book-meta').textContent = [b.author, b.format, b.file_size ? `${(b.file_size / 1024 / 1024).toFixed(1)} MB` : '']
    .filter(Boolean)
    .join(' · ');

  $('f-rating').value = b.my_rating || 0;
  $('f-status').value = b.my_status || 'unread';
  $('f-favorite').checked = Boolean(b.my_favorite);
  $('f-tags').value = (b.tags || []).join(', ');
  for (const f of FIELDS) $(`f-${f}`).value = b[f] || '';

  renderRatings(b);
  renderCover(b.cover || '');
  $('download').dataset.uploadId = b.upload_id || '';
}

$('save-state').addEventListener('click', async () => {
  const res = await api(`/api/books/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rating: Number($('f-rating').value) || 0,
      status: $('f-status').value,
      isFavorite: $('f-favorite').checked,
    }),
  });
  const data = await res.json().catch(() => ({}));
  $('state-msg').textContent = res.ok && data.ok ? '✓ 已保存' : `保存失败：${data.error || res.status}`;
  if (res.ok && data.ok) await load();
});

$('tags-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const tags = $('f-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const res = await api(`/api/books/${id}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  const data = await res.json().catch(() => ({}));
  $('tags-msg').textContent = res.ok && data.ok ? '✓ 标签已保存' : `保存失败：${data.error || res.status}`;
});

// —— 以下仅管理员 ——

$('save').addEventListener('click', async () => {
  const body = {};
  for (const f of FIELDS) body[f] = $(`f-${f}`).value;
  const res = await api(`/api/books/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('msg').textContent = res.ok && data.ok ? '✓ 已保存' : `保存失败：${data.error || res.status}`;
  if (res.ok && data.ok) {
    renderCover(body.cover);
    await load();
  }
});

$('delete').addEventListener('click', async () => {
  if (!confirm('删除后书籍档案与分块记录将移除，确定吗？')) return;
  const res = await api(`/api/books/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) location.href = '/library';
  else $('msg').textContent = `删除失败：${data.error || res.status}`;
});

$('cover-file').addEventListener('change', async () => {
  const file = $('cover-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await api(`/api/books/${id}/cover`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    $('msg').textContent = '✓ 封面已更新';
    renderCover(data.cover);
    $('f-cover').value = data.cover;
  } else {
    $('msg').textContent = `封面上传失败：${data.error || res.status}`;
  }
});

$('download').addEventListener('click', () => {
  const uploadId = $('download').dataset.uploadId;
  if (!uploadId) {
    $('state-msg').textContent = '该书暂无源文件';
    return;
  }
  location.href = `/download?focus=${encodeURIComponent(uploadId)}`;
});

async function init() {
  const data = await loadMe();
  me = data?.user || null;
  if (me?.role === 'admin') $('admin-panel').hidden = false;
  await load();
}

init();
