import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, '.wrangler');
const output = join(outputDir, 'cf-book-bootstrap.sql');
const schema = await readFile(join(root, 'schema.sql'), 'utf8');
const library = JSON.parse(await readFile(join(root, 'data/book_tag_library_v1.json'), 'utf8'));

const quote = (value) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const dimensions = library.dimensions
  .map((item) => `(${quote(item.dimension)}, ${quote(item.name_zh)}, ${quote(item.description)})`)
  .join(',\n');
const tags = library.tags
  .map((item) => `(${quote(item.tag_id)}, ${quote(item.name)}, ${quote(item.dimension)}, ${quote(item.category)}, ${quote(item.parent_id)}, ${quote(item.description)}, ${quote(item.status)})`)
  .join(',\n');
const aliases = library.tags
  .flatMap((item) => (item.aliases || []).map((alias) => `(${quote(item.tag_id)}, ${quote(alias)})`))
  .join(',\n');

if (library.dimensions.length !== 5 || library.tags.length !== 878) {
  throw new Error('标准标签库数量不符合预期，已停止生成初始化 SQL');
}

await mkdir(outputDir, { recursive: true });
await writeFile(output, `${schema}\n\n-- 为新建空库补齐完整标准标签库\nBEGIN;\nINSERT OR IGNORE INTO tag_dimensions (dimension, name_zh, description) VALUES\n${dimensions};\nINSERT OR IGNORE INTO standard_tags (tag_id, name, dimension, category, parent_id, description, status) VALUES\n${tags};\nINSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias) VALUES\n${aliases};\nCOMMIT;\n`);
console.log(`已生成 ${output}（5 个维度、878 个标准标签、${library.tags.flatMap((item) => item.aliases || []).length} 个别名）`);
