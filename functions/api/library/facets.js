import { json } from '../../utils/http.js';
import { listStandardTagDimensions } from '../../utils/standard-tags.js';
import { listShelves } from '../../utils/shelves.js';

export async function onRequestGet(context) {
  const [tags, shelves] = await Promise.all([
    listStandardTagDimensions(context.env),
    listShelves(context.env, context.data.user),
  ]);
  return json({
    ok: true,
    tags: {
      untaggedCount: tags.untaggedCount,
      dimensions: tags.dimensions.map(({ dimension, name_zh, tags: items }) => ({
        dimension,
        name_zh,
        tags: items.map(({ tag_id, name, count }) => ({ tag_id, name, count })),
      })),
    },
    shelves: shelves.map(({ id, name, scope, owner, book_count }) => ({ id, name, scope, owner, book_count })),
  }, 200, { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' });
}
