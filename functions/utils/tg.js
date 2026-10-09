const TG_API = 'https://api.telegram.org';

function botUrl(token, method) {
  return `${TG_API}/bot${token}/${method}`;
}

export function tgEnv(env) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    throw new Error('缺少 TG_BOT_TOKEN 或 TG_CHAT_ID 配置');
  }
  return { token: env.TG_BOT_TOKEN, chatId: String(env.TG_CHAT_ID) };
}

export async function tgSendChunk(env, chunkBytes, fileName) {
  const { token, chatId } = tgEnv(env);
  const fd = new FormData();
  fd.append('chat_id', chatId);
  fd.append(
    'document',
    new Blob([chunkBytes], { type: 'application/octet-stream' }),
    fileName
  );
  fd.append('disable_content_type_detection', 'true');

  const res = await fetch(botUrl(token, 'sendDocument'), { method: 'POST', body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram sendDocument 失败: ${body.description || res.status}`);
  }

  const doc = body.result?.document;
  if (!doc?.file_id) {
    throw new Error('Telegram 响应缺少 document.file_id');
  }
  return {
    chatId,
    fileId: doc.file_id,
    messageId: body.result.message_id,
    size: doc.file_size || chunkBytes.byteLength,
    fileName: doc.file_name || fileName,
  };
}

// 只查询文件元信息（不下载内容），用于校验分块是否还在 Telegram 上
export async function tgFileInfo(env, fileId) {
  const { token } = tgEnv(env);
  const infoRes = await fetch(
    `${botUrl(token, 'getFile')}?file_id=${encodeURIComponent(fileId)}`
  );
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile 失败: ${info.description || infoRes.status}`);
  }
  return {
    fileId: info.result.file_id,
    filePath: info.result.file_path,
    fileSize: Number(info.result.file_size) || 0,
  };
}

export async function tgDownloadChunk(env, fileId) {
  const { token } = tgEnv(env);
  const info = await tgFileInfo(env, fileId);
  const fileRes = await fetch(`${TG_API}/file/bot${token}/${info.filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Telegram 文件下载失败: ${fileRes.status}`);
  }
  return fileRes;
}

// 删除频道里的分块消息；消息本就已不存在视为成功，其他失败一律抛出
export async function tgDeleteMessage(env, chatId, messageId) {
  const { token } = tgEnv(env);
  const res = await fetch(botUrl(token, 'deleteMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), message_id: messageId }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.ok) return;
  const description = String(body.description || '');
  if (/message to delete not found/i.test(description)) return;
  throw new Error(description || `HTTP ${res.status}`);
}
