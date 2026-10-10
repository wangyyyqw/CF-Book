import { api, loadMe } from '/api.js';
const $ = (id) => document.getElementById(id);
const booksEl = $('books');
const searchEl = $('search');
const statusEl = $('status');
const countEl = $('count');
const previousEl = $('previous-page');
const nextEl = $('next-page');
const pageIndicator = $('page-indicator');
const tagFilterEl = $('tag-filter');
const shelfFilterEl = $('shelf-filter');
const recommendEl = $('recommend-books');
const recommendNote = $('recommend-note');
const refreshRecommendations = $('refresh-recommendations');
const shelfCreateForm = $('shelf-create');
const shelfNameEl = $('shelf-name');
const shelfScopeEl = $('shelf-scope');
const shelfCreateMsg = $('shelf-create-msg');
const shelfListEl = $('shelf-list');

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读', favorite: '收藏' };
const STATUS_CLASS = { unread: 's-unread', reading: 's-reading', read: 's-read', favorite: 's-fav' };

let page = 1;
let pageSize = 24;
let requestId = 0;
let recommendationRequestId = 0;
let me = null;
let shelves = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cardHtml(b, index) {
  const tagList = (b.tag_details || []).map((tag) => tag.name);
  const tags = tagList.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  // 徽标显示所有人打分的平均分，胶囊显示当前账号自己的阅读状态
  const count = Number(b.rating_count) || 0;
  const ratingBadge = count
    ? `<span class="bc-rating" title="${count} 人评分">${Number(b.rating_avg).toFixed(1)}</span>`
    : '';
  const myStatus = b.my_status || 'unread';
  const badgeLabel = b.my_favorite
    ? `${STATUS_LABEL[myStatus] || myStatus} · 收藏`
    : (STATUS_LABEL[myStatus] || myStatus);
  const badgeClass = b.my_favorite && myStatus === 'unread' ? 's-fav' : (STATUS_CLASS[myStatus] || '');
  const statusBadge =
    myStatus !== 'unread' || b.my_favorite
      ? `<span class="bc-status ${badgeClass}">${escapeHtml(badgeLabel)}</span>`
      : '';
  const cover = b.cover
    ? `<img src="${escapeHtml(b.cover)}" alt="" loading="lazy" />`
    : `<span class="bc-ph">${escapeHtml(((b.title || '书').trim()[0] || '书'))}</span>`;
  const overlay = tags ? `<div class="bc-overlay">${tags}</div>` : '';
  return `<a class="book-card" style="--i:${index}" href="/book?id=${encodeURIComponent(b.id)}">
      <div class="bc-cover">${cover}${ratingBadge}${statusBadge}${overlay}</div>
      <div class="bc-title">${escapeHtml(b.title || '未命名')}</div>
      <div class="bc-author">${escapeHtml(b.author || '佚名')}</div>
    </a>`;
}

async function loadRecommendations() {
  const columns = columnsForWidth();
  const token = ++recommendationRequestId;
  refreshRecommendations.disabled = true;
  try {
    const res = await api(`/api/books?recommended=1&limit=${columns}`);
    const data = await res.json().catch(() => ({}));
    if (token !== recommendationRequestId) return;
    if (!res.ok || !data.ok) return;
    recommendEl.innerHTML = data.books.map((book, index) => cardHtml(book, index)).join('');
    recommendNote.textContent = `随机抽取 ${data.books.length} 本`;
    if (!data.books.length) recommendEl.innerHTML = '<p class="empty">书库还没有推荐书籍。</p>';
  } finally {
    if (token === recommendationRequestId) refreshRecommendations.disabled = false;
  }
}

function columnsForWidth() {
  if (window.innerWidth <= 700) return 3;
  if (window.innerWidth <= 900) return 4;
  if (window.innerWidth <= 1080) return 5;
  return 6;
}

function pageSizeForWidth() {
  return columnsForWidth() * 4;
}

async function loadTags() {
  const res = await api('/api/tags');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return;
  const untaggedOption = document.createElement('option');
  untaggedOption.value = '__untagged__';
  untaggedOption.textContent = `无标签（${Number(data.untaggedCount) || 0}）`;
  tagFilterEl.appendChild(untaggedOption);
  for (const group of data.dimensions || []) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.name_zh;
    for (const tag of group.tags || []) {
      const option = document.createElement('option');
      option.value = tag.tag_id;
      option.textContent = `${tag.name}（${tag.count}）`;
      optgroup.appendChild(option);
    }
    if (optgroup.children.length) tagFilterEl.appendChild(optgroup);
  }
}

// 共享书架只有管理员能改名/删除，个人书架只有本人能动，与后端权限保持一致
function canManage(shelf) {
  if (!me) return false;
  if (shelf.scope === 'personal') return shelf.owner === me.username;
  return me.role === 'admin';
}

function renderShelves() {
  const current = shelfFilterEl.value;
  shelfFilterEl.innerHTML = '<option value="">全部书架</option>' +
    shelves.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}（${s.book_count}）</option>`).join('');
  if (shelves.some((s) => s.id === current)) shelfFilterEl.value = current;

  if (!shelves.length) {
    shelfListEl.innerHTML = '<li class="muted">还没有书架，新建一个来整理书籍。</li>';
    return;
  }
  shelfListEl.innerHTML = shelves.map((s) => {
    const scope = s.scope === 'personal' ? '个人' : '共享';
    const actions = canManage(s)
      ? `<button type="button" data-action="rename" data-id="${escapeHtml(s.id)}">改名</button>
         <button type="button" data-action="delete" data-id="${escapeHtml(s.id)}">删除</button>`
      : '';
    return `<li class="shelf-item">
        <span class="shelf-scope">${scope}</span>
        <button type="button" class="shelf-name" data-action="filter" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>
        <span class="shelf-count">${s.book_count} 本</span>
        <span class="shelf-actions">${actions}</span>
      </li>`;
  }).join('');
}

async function loadShelves() {
  const res = await api('/api/shelves');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return;
  shelves = data.shelves || [];
  renderShelves();
}

async function load({ reset = false } = {}) {
  if (reset) {
    page = 1;
    booksEl.innerHTML = '';
  }
  pageSize = pageSizeForWidth();
  const token = ++requestId;

  const params = new URLSearchParams();
  const q = searchEl.value.trim();
  if (q) params.set('q', q);
  if (statusEl.value) params.set('status', statusEl.value);
  if (tagFilterEl.value) params.set('tag', tagFilterEl.value);
  if (shelfFilterEl.value) params.set('shelf', shelfFilterEl.value);
  params.set('limit', String(pageSize));
  params.set('offset', String((page - 1) * pageSize));

  previousEl.disabled = true;
  nextEl.disabled = true;
  const res = await api(`/api/books?${params}`);
  const data = await res.json();
  if (token !== requestId) return; // 已有更新的请求，丢弃这次结果

  if (!res.ok || !data.ok) {
    booksEl.innerHTML = `<p class="empty">加载失败：${escapeHtml(data.error || res.status)}</p>`;
    pageIndicator.textContent = '';
    return;
  }

  if (!data.books.length && page === 1) {
    countEl.textContent = '';
    booksEl.innerHTML = '<p class="empty">这里还没有书，换个筛选条件或去“上传”页添加吧。</p>';
    pageIndicator.textContent = '第 1 页 / 共 1 页';
    return;
  }

  booksEl.innerHTML = data.books.map((b, i) => cardHtml(b, i)).join('');
  const pageCount = Math.max(1, Math.ceil(data.total / pageSize));
  countEl.textContent = `共 ${data.total} 本`;
  pageIndicator.textContent = `第 ${page} 页 / 共 ${pageCount} 页 · 本页 ${data.books.length} 本`;
  previousEl.disabled = page <= 1;
  nextEl.disabled = page >= pageCount;
}

function changePage(direction) {
  page += direction;
  load();
  window.scrollTo({ top: $('books').offsetTop - 24, behavior: 'smooth' });
}

searchEl.addEventListener('input', debounce(() => load({ reset: true }), 300));
statusEl.addEventListener('change', () => load({ reset: true }));
tagFilterEl.addEventListener('change', () => load({ reset: true }));
shelfFilterEl.addEventListener('change', () => load({ reset: true }));
previousEl.addEventListener('click', () => changePage(-1));
nextEl.addEventListener('click', () => changePage(1));
refreshRecommendations.addEventListener('click', loadRecommendations);

shelfCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = shelfNameEl.value.trim();
  if (!name) {
    shelfCreateMsg.textContent = '书架名称不能为空';
    return;
  }
  const res = await api('/api/shelves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scope: shelfScopeEl.value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    shelfCreateMsg.textContent = `新建失败：${data.error || res.status}`;
    return;
  }
  shelfNameEl.value = '';
  shelfCreateMsg.textContent = '✓ 已创建';
  await loadShelves();
});

shelfListEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const shelf = shelves.find((item) => item.id === button.dataset.id);
  if (!shelf) return;

  if (button.dataset.action === 'filter') {
    shelfFilterEl.value = shelf.id;
    await load({ reset: true });
    window.scrollTo({ top: booksEl.offsetTop - 24, behavior: 'smooth' });
    return;
  }

  if (button.dataset.action === 'rename') {
    const name = window.prompt('新的书架名称', shelf.name);
    if (name == null) return;
    const res = await api(`/api/shelves/${encodeURIComponent(shelf.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      shelfCreateMsg.textContent = `改名失败：${data.error || res.status}`;
      return;
    }
    await loadShelves();
    return;
  }

  if (button.dataset.action === 'delete') {
    if (!window.confirm(`删除书架「${shelf.name}」？书籍本身不会被删除。`)) return;
    const res = await api(`/api/shelves/${encodeURIComponent(shelf.id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      shelfCreateMsg.textContent = `删除失败：${data.error || res.status}`;
      return;
    }
    if (shelfFilterEl.value === shelf.id) {
      shelfFilterEl.value = '';
      await load({ reset: true });
    }
    await loadShelves();
  }
});

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function init() {
  const data = await loadMe();
  me = data?.user || null;
  // 非管理员不能建共享书架，直接隐藏这个选项
  if (me?.role !== 'admin') shelfScopeEl.querySelector('option[value="shared"]')?.remove();
  await Promise.all([load({ reset: true }), loadShelves(), loadTags(), loadRecommendations()]);
}

init();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pageSize !== pageSizeForWidth()) load({ reset: true });
    loadRecommendations();
  }, 180);
});
