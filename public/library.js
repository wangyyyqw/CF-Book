import { api } from '/api.js';
const $ = (id) => document.getElementById(id);
const booksEl = $('books');
const searchEl = $('search');
const statusEl = $('status');
const countEl = $('count');
const previousEl = $('previous-page');
const nextEl = $('next-page');
const pageIndicator = $('page-indicator');
const themeToggle = $('theme-toggle');
const tagFilterEl = $('tag-filter');
const recommendEl = $('recommend-books');
const recommendNote = $('recommend-note');

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读', favorite: '收藏' };
const STATUS_CLASS = { unread: 's-unread', reading: 's-reading', read: 's-read', favorite: 's-fav' };

let page = 1;
let pageSize = 24;
let requestId = 0;

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
  const res = await api(`/api/books?recommended=1&limit=${columns}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return;
  recommendEl.innerHTML = data.books.map((book, index) => cardHtml(book, index)).join('');
  recommendNote.textContent = `随机抽取 ${data.books.length} 本`;
  if (!data.books.length) recommendEl.innerHTML = '<p class="empty">书库还没有推荐书籍。</p>';
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
    booksEl.innerHTML = '<p class="empty">书库还没有书，去“上传”页添加吧。</p>';
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
previousEl.addEventListener('click', () => changePage(-1));
nextEl.addEventListener('click', () => changePage(1));

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

load({ reset: true });
loadRecommendations();
loadTags();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pageSize !== pageSizeForWidth()) load({ reset: true });
    loadRecommendations();
  }, 180);
});

themeToggle.addEventListener('click', () => {
  const dark = document.body.classList.toggle('library-dark');
  themeToggle.textContent = dark ? '浅色' : '暗色';
  themeToggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到暗色模式');
});
