import { json } from '../utils/http.js';
import { dbAll } from '../utils/db.js';
import { TAG_CATEGORY_ORDER, TAG_CATEGORY_LABELS, tagCategory } from '../utils/tag-catalog.js';

export async function onRequestGet(context) {
  const { env } = context;
  const tags = await dbAll(
    env,
    'SELECT t.name, t.category, COUNT(bt.book_id) AS count FROM tags t LEFT JOIN book_tags bt ON bt.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name'
  );
  const grouped = Object.fromEntries(TAG_CATEGORY_ORDER.map((category) => [category, {
    category,
    label: TAG_CATEGORY_LABELS[category],
    tags: tags.filter((tag) => (tag.category || tagCategory(tag.name)) === category),
  }]));
  return json({ ok: true, tags, categories: Object.values(grouped) });
}
