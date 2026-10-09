export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

// Set-Cookie 需要绕过浏览器端 Headers 的 forbidden 检查，单独构造
export function jsonWithCookies(data, cookies, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
