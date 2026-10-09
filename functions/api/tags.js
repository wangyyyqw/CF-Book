import { json } from '../utils/http.js';
import { listStandardTagDimensions } from '../utils/standard-tags.js';

export async function onRequestGet(context) {
  const { env } = context;
  const result = await listStandardTagDimensions(env);
  return json({ ok: true, ...result });
}
