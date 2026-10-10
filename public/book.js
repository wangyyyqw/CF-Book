import { api, loadMe, escapeHtml } from '/api.js';
import { downloadBook } from '/download-core.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' };
const MAX_COMMENT_LENGTH = 500;

let me = null;
let tagDimensions = [];
let tagSelects = [];
let shelfOptions = [];
let shelfSelection = new Set();

function updateCommentCount() {
  const value = $('f-comment').value || '';
  $('comment-count').textContent = `${value.length} / ${MAX_COMMENT_LENGTH}`;
}

async function loadShelfPicker(selectedIds) {
  shelfSelection = new Set(selectedIds || []);
  const picker = $('shelf-picker');
  const res = await api('/api/shelves');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    picker.innerHTML = '<span class="muted">书架列表加载失败</span>';
    return;
  }
  shelfOptions = data.shelves || [];
  if (!shelfOptions.length) {
    picker.innerHTML = '<span class="muted">还没有书架，去书库页新建一个。</span>';
    return;
  }
  picker.innerHTML = shelfOptions.map((shelf) => `<label class="shelf-check">
      <input type="checkbox" value="${escapeHtml(shelf.id)}" ${shelfSelection.has(shelf.id) ? 'checked' : ''} />
      <span>${escapeHtml(shelf.name)}</span>
      <span class="shelf-scope">${shelf.scope === 'personal' ? '个人' : '共享'}</span>
    </label>`).join('');
}

async function loadTagOptions(selectedIds = []) {
  const response = await api('/api/tags?include_unused=1');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || '标签列表加载失败');
  tagDimensions = data.dimensions || [];
  const selected = new Set(selectedIds);
  $('standard-tag-selects').innerHTML = '<label>书籍类型<select id="tag-type" required></select></label><label><span id="tag-second-label"></span><select id="tag-second" required></select></label><label><span id="tag-third-label"></span><select id="tag-third" required></select></label>';
  tagSelects = [$('tag-type'), $('tag-second'), $('tag-third')];
  fillTagSelect(tagSelects[0], tagDimensions.find((item) => item.dimension === 'book_type'), selected);
  const updateDependent = (preserve) => {
    const web = tagSelects[0].value === 'BOOK_TYPE_0002';
    (web ? ['web_genre', 'web_element'] : ['pub_field', 'pub_topic']).forEach((key, index) => {
      const dimension = tagDimensions.find((item) => item.dimension === key);
      $(`tag-${index === 0 ? 'second' : 'third'}-label`).textContent = dimension?.name_zh || '';
      fillTagSelect(tagSelects[index + 1], dimension, preserve ? selected : new Set());
    });
    selected.clear();
  };
  tagSelects[0].addEventListener('change', () => updateDependent(false));
  updateDependent(true);
}

function fillTagSelect(select, dimension, selected) {
  select.innerHTML = `<option value="">请选择</option>${(dimension?.tags || []).map((tag) => `<option value="${escapeHtml(tag.tag_id)}" ${selected.has(tag.tag_id) ? 'selected' : ''}>${escapeHtml(tag.name)} · ${escapeHtml(tag.category)}</option>`).join('')}`;
}

function renderCover(url) {
  const img = $('cover');
  const placeholder = $('cover-placeholder');
  if (url) {
    img.src = url;
    img.hidden = false;
    placeholder.hidden = true;
    img.style.display = 'block';
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    placeholder.hidden = false;
  }
}

function renderRatings(book) {
  $('ratings-title').textContent = book.rating_count
    ? `大家的打分 · 平均 ${Number(book.rating_avg).toFixed(1)}（${book.rating_count} 人）`
    : '大家的打分';

  const rows = (book.ratings || []).filter((r) => Number(r.rating) > 0 || r.status !== 'unread' || r.comment);
  if (!rows.length) {
    $('ratings').innerHTML = '<li class="muted">还没有人打分或标记状态</li>';
    return;
  }
  $('ratings').innerHTML = rows
    .map((r) => {
      const mine = me && r.user_id === me.id;
      const score = Number(r.rating) > 0 ? Number(r.rating).toFixed(1) : '—';
      const comment = r.comment
        ? `<p class="rating-comment">${escapeHtml(r.comment)}</p>`
        : '';
      return `<li class="${mine ? 'mine' : ''}">
        <div class="rating-head">
          <span class="who">${escapeHtml(r.display_name || r.username)}${mine ? '（我）' : ''}</span>
          <span class="score">${score}</span>
          <span class="st">${escapeHtml(STATUS_LABEL[r.status] || r.status)}${r.is_favorite ? ' · 收藏' : ''}</span>
        </div>
        ${comment}
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
  $('f-comment').value = b.my_comment || '';
  updateCommentCount();
  await loadTagOptions((b.tag_details || []).map((tag) => tag.tag_id));
  $('tag-groups').innerHTML = (b.tag_details || []).length
    ? (b.tag_details || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag.name)}</span>`).join('')
    : '<span class="muted">暂无标签，请在下方手动添加</span>';
  if (tagSelects.length) {
    const selectedIds = (b.tag_details || []).map((tag) => tag.tag_id);
    selectedIds.forEach((tagId, index) => { if (tagSelects[index]) tagSelects[index].value = tagId; });
  }
  renderRatings(b);
  $('cover-placeholder').textContent = (b.title || '书').trim().slice(0, 2);
  renderCover(b.cover || '');
  $('download').dataset.uploadId = b.upload_id || '';
  $('download').dataset.filename = b.file_name || b.title || 'download';
  await loadShelfPicker(b.shelf_ids || []);
  if (me?.role === 'admin') {
    $('edit-book').hidden = false;
    $('ai-classify-book').hidden = false;
    $('ai-classify-panel').hidden = false;
  }
}

$('save-state').addEventListener('click', async () => {
  const res = await api(`/api/books/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rating: Number($('f-rating').value) || 0,
      status: $('f-status').value,
      isFavorite: $('f-favorite').checked,
      comment: $('f-comment').value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  $('state-msg').textContent = res.ok && data.ok ? '✓ 已保存' : `保存失败：${data.error || res.status}`;
  if (res.ok && data.ok) await load();
});

$('save-shelves').addEventListener('click', async () => {
  const boxes = [...$('shelf-picker').querySelectorAll('input[type="checkbox"]')];
  const next = new Set(boxes.filter((box) => box.checked).map((box) => box.value));
  const changed = shelfOptions.filter((shelf) => next.has(shelf.id) !== shelfSelection.has(shelf.id));
  if (!changed.length) {
    $('shelves-msg').textContent = '书架没有变化';
    return;
  }
  $('shelves-msg').textContent = '正在保存…';
  for (const shelf of changed) {
    const res = await api(`/api/shelves/${encodeURIComponent(shelf.id)}/books`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next.has(shelf.id) ? { add: [id] } : { remove: [id] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('shelves-msg').textContent = `保存失败：${data.error || res.status}`;
      return;
    }
  }
  $('shelves-msg').textContent = '✓ 书架已更新';
  await load();
});

$('tags-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const tagIds = tagSelects.map((select) => select.value);
  const res = await api(`/api/books/${id}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagIds }),
  });
  const data = await res.json().catch(() => ({}));
  $('tags-msg').textContent = res.ok && data.ok ? '✓ 标签已保存' : `保存失败：${data.error || res.status}`;
  if (res.ok && data.ok) await load();
});

$('download').addEventListener('click', () => {
  const uploadId = $('download').dataset.uploadId;
  if (!uploadId) {
    $('state-msg').textContent = '该书暂无源文件';
    return;
  }
  $('download').disabled = true;
  $('download-msg').textContent = '正在准备下载…';
  downloadBook(uploadId, $('download').dataset.filename, {
    preferFilePicker: true,
    onMessage: (text) => { $('download-msg').textContent = text; },
    onProgress: (state) => {
      $('download-msg').textContent = `已下载 ${state.done}/${state.total} 块（${state.percent.toFixed(0)}%）`;
    },
  }).catch((error) => {
    $('download-msg').textContent = `下载失败：${error.message}`;
  }).finally(() => { $('download').disabled = false; });
});

$('edit-book').addEventListener('click', () => {
  location.href = `/edit?id=${encodeURIComponent(id)}`;
});

$('ai-classify-book').addEventListener('click', async () => {
  const button = $('ai-classify-book');
  button.disabled = true;
  $('ai-classify-msg').textContent = '正在请求模型，仅处理当前书籍…';
  $('ai-classify-debug').hidden = true;
  try {
    const res = await api(`/api/books/${encodeURIComponent(id)}/classify`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const result = data.result;
    if (data.debug || result?.debug) {
      $('ai-classify-debug-content').textContent = JSON.stringify(data.debug || result.debug, null, 2);
      $('ai-classify-debug').hidden = false;
      $('ai-classify-debug').open = true;
    }
    if (!res.ok || !data.ok) {
      $('ai-classify-msg').textContent = `分类失败：${data.error || res.status}`;
      return;
    }
    $('ai-classify-msg').textContent = `✓ 已完成：${result.title} · ${result.tags.join('、')}`;
    await load();
  } catch (error) {
    $('ai-classify-msg').textContent = `分类请求失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

async function init() {
  const data = await loadMe();
  me = data?.user || null;
  if (me?.role === 'admin') $('edit-book').hidden = false;
  await load();
}

init();

$('f-comment').addEventListener('input', updateCommentCount);
