import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../data/book_tag_library_v1.json', import.meta.url);
const output = new URL('../migrations/0012_humanities_and_web_tags.sql', import.meta.url);
const library = JSON.parse(await readFile(source, 'utf8'));

if (library.tags.length !== 878 || library.dimensions.length !== 5) {
  throw new Error('标准标签库数量或维度不符合预期');
}

const quote = (value) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const newTagIds = [
  ...Array.from({ length: 16 }, (_, i) => `PUB_FIELD_${String(i + 134).padStart(4, '0')}`),
  ...Array.from({ length: 74 }, (_, i) => `PUB_TOPIC_${String(i + 281).padStart(4, '0')}`),
  ...Array.from({ length: 35 }, (_, i) => `WEB_GENRE_${String(i + 114).padStart(4, '0')}`),
  ...Array.from({ length: 53 }, (_, i) => `WEB_ELEMENT_${String(i + 173).padStart(4, '0')}`),
];
const additions = library.tags.filter((item) => newTagIds.includes(item.tag_id));
if (additions.length !== newTagIds.length) throw new Error('增量标签 ID 缺失');
const lines = [
  '-- 扩充哲学与人文非虚构、专业类型小说和网文细分题材；既有图书标签关系不变。',
  `INSERT INTO standard_tags (tag_id, name, dimension, category, parent_id, description, status) VALUES ${additions
    .map((item) => `(${quote(item.tag_id)}, ${quote(item.name)}, ${quote(item.dimension)}, ${quote(item.category)}, ${quote(item.parent_id)}, ${quote(item.description)}, ${quote(item.status)})`).join(',\n')};`,
];

await writeFile(output, `${lines.join('\n\n')}\n`);
console.log(`已生成迁移 SQL：新增 ${additions.length} 个标准标签`);
