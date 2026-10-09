import { api, loadMe, escapeHtml } from '/api.js';
import { downloadBook } from '/download-core.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

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
  renderRatings(b);
  renderCover(b.cover || '');
  $('download').dataset.uploadId = b.upload_id || '';
  $('download').dataset.filename = b.file_name || b.title || 'download';
  if (me?.role === 'admin') $('edit-book').hidden = false;
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

$('download').addEventListener('click', () => {
  const uploadId = $('download').dataset.uploadId;
  if (!uploadId) {
    $('state-msg').textContent = '该书暂无源文件';
    return;
  }
  $('download').disabled = true;
  $('download-msg').textContent = '正在下载并合并分块…';
  downloadBook(uploadId, $('download').dataset.filename, {
    onMessage: (text) => { $('download-msg').textContent = text; },
  }).catch((error) => {
    $('download-msg').textContent = `下载失败：${error.message}`;
  }).finally(() => { $('download').disabled = false; });
});

$('edit-book').addEventListener('click', () => {
  location.href = `/edit?id=${encodeURIComponent(id)}`;
});

async function init() {
  const data = await loadMe();
  me = data?.user || null;
  if (me?.role === 'admin') $('edit-book').hidden = false;
  await load();
}

init();
