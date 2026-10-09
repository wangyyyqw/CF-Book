import { json, err } from '../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../utils/db.js';
import { sha256Hex } from '../../utils/hash.js';
import { tgSendChunk } from '../../utils/tg.js';

const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData().catch(() => null);
  if (!form) return err('请求体必须是 multipart/form-data');

  const uploadId = String(form.get('uploadId') || '');
  const index = Number(form.get('index'));
  const file = form.get('file');
  if (!uploadId || !Number.isInteger(index) || index < 0 || !file) {
    return err('缺少 uploadId / index / file');
  }

  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (context.data.user.role !== 'admin' && upload.owner !== context.data.user.username) {
    return err('无权操作其他账号的上传任务', 403);
  }
  if (upload.status !== 'active') return err(`任务状态为 ${upload.status}，无法上传分块`, 409);
  if (index >= upload.total_chunks) return err('分块序号越界');

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_CHUNK_SIZE) return err('分块超过 16 MiB');

  const expectedSize =
    index === upload.total_chunks - 1
      ? upload.total_size - index * upload.chunk_size
      : upload.chunk_size;
  if (bytes.byteLength !== expectedSize) {
    return err(`分块大小不符：期望 ${expectedSize}，实际 ${bytes.byteLength}`);
  }

  const sha256 = await sha256Hex(bytes);
  const fileName = `${upload.filename}.part${String(index).padStart(3, '0')}`;
  const tg = await tgSendChunk(env, bytes, fileName);

  await dbRun(
    env,
    `UPDATE chunks
     SET size = ?, sha256 = ?, status = 'uploaded', tg_chat_id = ?, tg_message_id = ?, tg_file_id = ?, error = '', updated_at = ?
     WHERE upload_id = ? AND idx = ?`,
    bytes.byteLength,
    sha256,
    tg.chatId,
    tg.messageId,
    tg.fileId,
    nowSec(),
    uploadId,
    index
  );

  return json({
    ok: true,
    index,
    status: 'uploaded',
    sha256,
    tgMessageId: tg.messageId,
    tgFileId: tg.fileId,
  });
}
