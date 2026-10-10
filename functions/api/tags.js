import { json } from '../utils/http.js';
import { listStandardTagDimensions } from '../utils/standard-tags.js';

export async function onRequestGet(context) {
  const { env } = context;
  const includeUnused = new URL(context.request?.url || 'https://example.com/api/tags').searchParams.get('include_unused') === '1';
  const result = await listStandardTagDimensions(env, { includeUnused });
  return json({ ok: true, ...result }, 200, { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' });
}
