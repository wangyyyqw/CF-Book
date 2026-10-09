// 按顺序处理文件，避免多本书同时占满浏览器和 Telegram 上传通道。
export async function runUploadQueue(files, upload, {
  signal,
  onStart = () => {},
  onSuccess = () => {},
  onError = () => {},
  onCancel = () => {},
} = {}) {
  const results = [];
  for (const file of files) {
    if (signal?.aborted) {
      results.push({ file, status: 'cancelled' });
      onCancel(file);
      continue;
    }
    onStart(file);
    try {
      const value = await upload(file);
      results.push({ file, status: 'completed', value });
      onSuccess(file, value);
    } catch (error) {
      if (signal?.aborted) {
        results.push({ file, status: 'cancelled' });
        onCancel(file, error);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ file, status: 'failed', error: message });
        onError(file, error);
      }
    }
  }
  return results;
}
