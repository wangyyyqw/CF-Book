import { json } from '../../utils/http.js';
import { dbAll } from '../../utils/db.js';

export async function onRequestGet(context) {
  const { env } = context;
  const uploads = await dbAll(
    env,
    `SELECT u.*,
       (SELECT COUNT(*) FROM chunks c WHERE c.upload_id = u.upload_id AND c.status = 'uploaded') AS uploaded_chunks
     FROM uploads u
     ORDER BY (u.status = 'completed') DESC, u.updated_at DESC
     LIMIT 200`
  );
  return json({ ok: true, uploads });
}
