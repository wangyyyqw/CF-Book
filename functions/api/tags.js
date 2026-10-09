import { json } from '../utils/http.js';
import { listStandardTagDimensions } from '../utils/standard-tags.js';

export async function onRequestGet(context) {
  const { env } = context;
  return json({ ok: true, dimensions: await listStandardTagDimensions(env) });
}
