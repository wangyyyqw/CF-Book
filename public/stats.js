import { api, loadMe, escapeHtml } from '/api.js';
import { formatBytes } from '/format.js';

const $ = (id) => document.getElementById(id);

const DIMENSION_LABEL = {
  book_type: '书籍类型',
  pub_field: '出版领域',
  pub_topic: '出版主题',
  web_genre: '网文类型',
  web_element: '网文设定',
};

function groupTagsByDimension(tags) {
  const order = ['book_type', 'pub_field', 'pub_topic', 'web_genre', 'web_element'];
  const groups = new Map();
  for (const tag of tags) {
    if (!groups.has(tag.dimension)) groups.set(tag.dimension, []);
    groups.get(tag.dimension).push(tag);
  }
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

async function loadStats() {
  const res = await api('/api/library/stats');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('stats-msg').textContent = `统计读取失败：${data.error || res.status}`;
    return;
  }
  $('stats-msg').textContent = '';
  $('stats-overview').innerHTML = `
    <div><span>书籍总数</span><strong>${data.totals.books}</strong></div>
    <div><span>占用大小</span><strong>${formatBytes(data.totals.size)}</strong></div>`;

  const sections = [
    { title: '按格式', rows: data.formats, label: (name) => name || '未知格式' },
    { title: '按语言', rows: data.languages, label: (name) => name || '未标注语言' },
  ];
  for (const [dimension, rows] of groupTagsByDimension(data.tags)) {
    sections.push({ title: DIMENSION_LABEL[dimension] || dimension, rows, label: (name) => name });
  }

  $('stats-sections').innerHTML = sections.map((section) => {
    const items = section.rows.length
      ? section.rows.map((row) =>
          `<li><span>${escapeHtml(section.label(row.name))}</span><strong>${row.count}</strong><em>${formatBytes(row.size)}</em></li>`).join('')
      : '<li class="muted">暂无数据</li>';
    return `<div class="stats-block">
        <h3>${escapeHtml(section.title)}</h3>
        <ul class="stats-list">${items}</ul>
      </div>`;
  }).join('');
}

loadMe().then((data) => {
  const me = data?.user || null;
  if (me && me.role !== 'admin') {
    document.querySelector('.shell').innerHTML = '<p class="empty">仅管理员可查看书库统计。</p>';
    return;
  }
  loadStats();
});
