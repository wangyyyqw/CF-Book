import { api, escapeHtml } from '/api.js';

const id = new URLSearchParams(location.search).get('id');
const fields = ['title', 'author', 'description', 'publisher', 'isbn', 'language', 'format'];
const $ = (key) => document.getElementById(key);
let tagDimensions = [];
let tagSelects = [];

async function loadTagOptions(selectedIds = []) {
  const response = await api('/api/tags?include_unused=1');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || '标签列表加载失败');
  tagDimensions = data.dimensions || [];
  const selected = new Set(selectedIds);
  $('standard-tag-selects').innerHTML = '<label>书籍类型<select id="tag-type" required></select></label><label><span id="tag-second-label"></span><select id="tag-second" required></select></label><label><span id="tag-third-label"></span><select id="tag-third" required></select></label>';
  tagSelects = [$('tag-type'), $('tag-second'), $('tag-third')];
  const typeDimension = tagDimensions.find((item) => item.dimension === 'book_type');
  fillSelect(tagSelects[0], typeDimension, selected);
  const updateDependent = (preserve = false) => {
    const web = tagSelects[0].value === 'BOOK_TYPE_0002';
    const dimensions = web ? ['web_genre', 'web_element'] : ['pub_field', 'pub_topic'];
    dimensions.forEach((key, index) => {
      const dimension = tagDimensions.find((item) => item.dimension === key);
      $(`tag-${index === 0 ? 'second' : 'third'}-label`).textContent = dimension?.name_zh || '';
      fillSelect(tagSelects[index + 1], dimension, preserve ? selected : new Set());
    });
    selected.clear();
  };
  tagSelects[0].addEventListener('change', () => updateDependent(false));
  updateDependent(true);
}

function fillSelect(select, dimension, selected) {
  select.innerHTML = `<option value="">请选择</option>${(dimension?.tags || []).map((tag) => `<option value="${escapeHtml(tag.tag_id)}" ${selected.has(tag.tag_id) ? 'selected' : ''}>${escapeHtml(tag.name)} · ${escapeHtml(tag.category)}</option>`).join('')}`;
}

function message(text) {
  $('msg').textContent = text;
}

async function load() {
  if (!id) return message('缺少书籍 ID');
  $('back-book').href = `/book?id=${encodeURIComponent(id)}`;
  const res = await api(`/api/books/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return message(`加载失败：${data.error || res.status}`);
  for (const field of fields) $(`f-${field}`).value = data.book[field] || '';
  await loadTagOptions((data.book.tag_details || []).map((tag) => tag.tag_id));
}

$('save').addEventListener('click', async () => {
  const tagIds = tagSelects.map((select) => select.value);
  if (tagIds.some((value) => !value)) return message('请先选择完整的三个标准标签');
  const body = Object.fromEntries(fields.map((field) => [field, $(`f-${field}`).value]));
  body.tagIds = tagIds;
  const bookRes = await api(`/api/books/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const bookData = await bookRes.json().catch(() => ({}));
  if (!bookRes.ok || !bookData.ok) return message(`保存失败：${bookData.error || bookRes.status}`);

  message('✓ 修改已保存');
});

$('cover-file').addEventListener('change', async () => {
  const file = $('cover-file').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await api(`/api/books/${encodeURIComponent(id)}/cover`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  message(res.ok && data.ok ? '✓ 封面已更新' : `封面上传失败：${data.error || res.status}`);
});

$('delete').addEventListener('click', async () => {
  if (!confirm('删除后书籍、封面和原文件分块都会移除，确定吗？')) return;
  const res = await api(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) location.href = '/library';
  else message(`删除失败：${data.error || res.status}`);
});

load();
