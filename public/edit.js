import { api, escapeHtml } from '/api.js';

const id = new URLSearchParams(location.search).get('id');
const fields = ['title', 'author', 'description', 'publisher', 'isbn', 'language', 'format'];
const $ = (key) => document.getElementById(key);

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
  $('f-tags').value = (data.book.tags || []).join(', ');
}

$('save').addEventListener('click', async () => {
  const body = Object.fromEntries(fields.map((field) => [field, $(`f-${field}`).value]));
  const bookRes = await api(`/api/books/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const bookData = await bookRes.json().catch(() => ({}));
  if (!bookRes.ok || !bookData.ok) return message(`保存失败：${bookData.error || bookRes.status}`);

  const tags = $('f-tags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  const tagRes = await api(`/api/books/${encodeURIComponent(id)}/tags`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }),
  });
  const tagData = await tagRes.json().catch(() => ({}));
  message(tagRes.ok && tagData.ok ? '✓ 修改已保存' : `标签保存失败：${tagData.error || tagRes.status}`);
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
