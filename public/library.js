import { api } from '/api.js';
const $ = (id) => document.getElementById(id);
const booksEl = $('books');
const searchEl = $('search');
const statusEl = $('status');
const countEl = $('count');
const moreEl = $('more');

const PAGE_SIZE = 100;
const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读', favorite: '收藏' };
const STATUS_CLASS = { unread: 's-unread', reading: 's-reading', read: 's-read', favorite: 's-fav' };

// offset 是「已渲染条数」，每次请求从它往后取；requestId 用来丢弃过期的响应
let offset = 0;
let requestId = 0;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cardHtml(b, index) {
  const tagList = (b.tags || '').split(',').filter(Boolean);
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

async function load({ reset = false } = {}) {
  if (reset) {
    offset = 0;
    booksEl.innerHTML = '';
  }
  const token = ++requestId;

  const params = new URLSearchParams();
  const q = searchEl.value.trim();
  if (q) params.set('q', q);
  if (statusEl.value) params.set('status', statusEl.value);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  moreEl.disabled = true;
  const res = await api(`/api/books?${params}`);
  const data = await res.json();
  if (token !== requestId) return; // 已有更新的请求，丢弃这次结果
  moreEl.disabled = false;

  if (!res.ok || !data.ok) {
    booksEl.innerHTML = `<p class="empty">加载失败：${escapeHtml(data.error || res.status)}</p>`;
    moreEl.hidden = true;
    return;
  }

  if (!data.books.length && offset === 0) {
    countEl.textContent = '';
    booksEl.innerHTML = '<p class="empty">书库还没有书，去“上传”页添加吧。</p>';
    moreEl.hidden = true;
    return;
  }

  booksEl.insertAdjacentHTML('beforeend', data.books.map((b, i) => cardHtml(b, offset + i)).join(''));
  offset += data.books.length;
  countEl.textContent = offset >= data.total ? `共 ${data.total} 本` : `已显示 ${offset} / 共 ${data.total} 本`;
  moreEl.hidden = !data.hasMore;
}

searchEl.addEventListener('input', debounce(() => load({ reset: true }), 300));
statusEl.addEventListener('change', () => load({ reset: true }));
moreEl.addEventListener('click', () => load());

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

load({ reset: true });
