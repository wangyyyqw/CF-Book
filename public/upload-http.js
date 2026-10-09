export async function readJsonResponse(response, action = '请求') {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${action}失败：服务器返回了非 JSON 响应（HTTP ${response.status}）`);
    error.retryable = response.status >= 500 || response.status === 0 || /^\s*</.test(text);
    error.status = response.status;
    throw error;
  }
}

export function responseError(response, data, action = '请求') {
  const error = new Error(data?.error || `${action}失败（HTTP ${response.status}）`);
  error.retryable = response.status >= 500 || response.status === 429;
  error.status = response.status;
  return error;
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
